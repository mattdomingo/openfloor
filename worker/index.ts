import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { BASE_PATH } from "../components/basePath";
import type { D1DatabaseLike } from "../db";
import {
  cloudflareAccessIdentity,
  localDevelopmentIdentity,
  requestWithTrustedIdentity,
  type IdentityEnvironment,
} from "../lib/identity";
import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";
import { purgeExpiredSessions } from "../db/sessions";
import {
  finishSandboxCleanup,
  getPreviewMemberUserId,
  getPreviewProxyContext,
  retrySandboxCleanup,
  takeDueSandboxCleanup,
  takeExpiredRepositoryPreviews,
} from "../db/previews";
import { retirePoolSandbox, takeEvictablePoolSandboxes } from "../db/sandbox-pool";
import { notifyFloorChanged, notifyMembersChanged } from "../lib/presence-server";
import { violatesBrowserMutationPolicy, withSecurityHeaders } from "../lib/http-security";
import { handlePresenceRequest, SessionPresence } from "./presence";
import { SessionRouter } from "./session-router";
import { RepositoryPreflightWorkflow } from "./preflight-workflow";
import { AgentRunWorkflow } from "./agent-run-workflow";
import { RepositoryPreviewWorkflow } from "./preview-workflow";
import { sweepStorageCleanup } from "./storage-cleanup";
import { purgeExpiredWaitlist, sweepWaitlistSheetSync } from "../db/early-access";
import type { EarlyAccessBindings } from "../lib/early-access";
import { earlyAccessGateEnabled } from "../lib/early-access";
import { isPreviewHostname, previewFrameAncestor, rewritePreviewResponse, stripAccessCredentials } from "../lib/preview-proxy";
export { Sandbox, ContainerProxy } from "@cloudflare/sandbox";

export { AgentRunWorkflow, RepositoryPreflightWorkflow, RepositoryPreviewWorkflow, SessionPresence, SessionRouter };

type DurableObjectStubLike = { fetch(request: Request): Promise<Response> };
type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

interface Env extends IdentityEnvironment, EarlyAccessBindings {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1DatabaseLike;
  PREFLIGHT_LOGS: {
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
    delete(keys: string | string[]): Promise<void>;
  };
  USER_AVATARS: {
    list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
    delete(keys: string | string[]): Promise<void>;
  };
  SANDBOX: DurableObjectNamespace<Sandbox>;
  REPOSITORY_PREVIEW_ENABLED?: string;
  OPENFLOOR_PREVIEW_HOSTNAME?: string;
  OPENFLOOR_RUNTIME_ORIGIN?: string;
  SESSION_PRESENCE: DurableObjectNamespaceLike;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

async function serveAsset(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const asset = await env.ASSETS.fetch(request);
  return asset.status === 404 ? null : asset;
}

// A browser can land a signed-in document navigation on a bare /api/* path
// if the path-scoped Access application is exposed in the App Launcher. No
// route serves that path, so without this it renders a bare
// "Not Found" instead of a real page. sec-fetch-mode: navigate is a Fetch
// Metadata header every modern browser attaches only to top-level document
// navigations — never to a fetch()/XHR call — so this is the one signal that
// can't misfire on a genuine API 404. An Accept-header check was tried and
// dropped: real API calls in this codebase's own test helpers reuse
// Accept: text/html, which made it redirect member-only 404s meant to stay
// 404 (tests/render/skills.test.ts, tests/render/mcp-servers.test.ts).
function isApiDocumentNavigation(request: Request, url: URL): boolean {
  if (request.method !== "GET") return false;
  if (!url.pathname.startsWith(`${BASE_PATH}/api/`)) return false;
  return request.headers.get("sec-fetch-mode") === "navigate";
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isPreviewHostname(url.hostname, env.OPENFLOOR_PREVIEW_HOSTNAME)) {
      return handlePreviewProxy(request, env);
    }
    if (violatesBrowserMutationPolicy(request, url)) {
      return withSecurityHeaders(Response.json({ error: "Cross-site mutation rejected" }, { status: 403 }), url);
    }
    const presenceResponse = await handlePresenceRequest(request, env);
    if (presenceResponse) return withSecurityHeaders(presenceResponse, url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return withSecurityHeaders(await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths), url);
    }

    const asset = await serveAsset(request, env);
    if (asset) return withSecurityHeaders(asset, url);

    const identityHeaders = new Headers(request.headers);
    if (!identityHeaders.has("host")) identityHeaders.set("host", url.host);
    const identity = localDevelopmentIdentity(identityHeaders, env)
      ?? await cloudflareAccessIdentity(identityHeaders, env);
    const response = await handler.fetch(requestWithTrustedIdentity(request, identity), env, ctx);
    if (response.status === 404 && isApiDocumentNavigation(request, url)) {
      return withSecurityHeaders(Response.redirect(new URL(`${BASE_PATH}/home`, url), 302), url);
    }
    return withSecurityHeaders(response, url);
  },

  // Cron entry points (wrangler.jsonc triggers.crons). Thin by design: the
  // logic lives in the testable db helpers.
  async scheduled(controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = (controller as { cron?: string } | null)?.cron;
    ctx.waitUntil((async () => {
      if (cron === POOL_SWEEP_CRON) {
        await Promise.all([
          sweepSandboxPool(env),
          sweepRepositoryPreviews(env),
          sweepStorageCleanup(env),
          sweepWaitlistSheetSync(env.DB, env),
        ]);
        return;
      }
      const [deletedSessionIds] = await Promise.all([
        purgeExpiredSessions(env.DB),
        purgeExpiredWaitlist(env.DB),
        sweepStorageCleanup(env),
      ]);
      await Promise.all(deletedSessionIds.map((sessionId) => notifyMembersChanged(sessionId)));
    })());
  },
};

const POOL_SWEEP_CRON = "*/10 * * * *";

// Destroys warm-pool sandboxes that sat idle past their TTL or whose claiming
// workflow died without releasing them. Rows go idle/claimed → draining →
// deleted, so a sweep that crashes mid-destroy retries on the next firing.
async function sweepSandboxPool(env: Env): Promise<void> {
  const ids = await takeEvictablePoolSandboxes(env.DB);
  for (const id of ids) {
    try {
      await getSandbox(env.SANDBOX, id, { enableDefaultSession: false, normalizeId: true }).destroy();
      await retirePoolSandbox(id, env.DB);
    } catch {
      // Row stays draining; the next sweep retries the destroy.
    }
  }
}

async function sweepRepositoryPreviews(env: Env): Promise<void> {
  const expired = await takeExpiredRepositoryPreviews(env.DB);
  await Promise.all(expired.map((preview) => notifyFloorChanged(preview.sessionId, preview.revision, ["preview"])));
  const sandboxIds = await takeDueSandboxCleanup(env.DB);
  for (const sandboxId of sandboxIds) {
    try {
      await getSandbox(env.SANDBOX, sandboxId, { enableDefaultSession: false, normalizeId: true }).destroy();
      await finishSandboxCleanup(sandboxId, env.DB);
    } catch (error) {
      await retrySandboxCleanup(sandboxId, error instanceof Error ? error.message : "Sandbox destruction failed", env.DB);
    }
  }
}

async function handlePreviewProxy(request: Request, env: Env): Promise<Response> {
  if (env.REPOSITORY_PREVIEW_ENABLED !== "true") return new Response("Not found", { status: 404 });
  const frameAncestor = previewFrameAncestor(env.OPENFLOOR_RUNTIME_ORIGIN);
  if (!frameAncestor) return new Response("Not found", { status: 404 });
  const headers = new Headers(request.headers);
  if (!headers.has("host")) headers.set("host", new URL(request.url).host);
  const identity = localDevelopmentIdentity(headers, env) ?? await cloudflareAccessIdentity(headers, env);
  if (!identity) return new Response("Not found", { status: 404 });
  const userId = await getPreviewMemberUserId(identity.providerUserId, identity.email, env.DB);
  if (!userId) return new Response("Not found", { status: 404 });
  const host = new URL(request.url).host.toLowerCase();
  const context = await getPreviewProxyContext(host, userId, earlyAccessGateEnabled(env), env.DB);
  if (!context) return new Response("Not found", { status: 404 });
  const proxied = await proxyToSandbox(
    new Request(request, { headers: stripAccessCredentials(headers) }),
    { Sandbox: env.SANDBOX },
  );
  if (!proxied) return new Response("Not found", { status: 404 });
  return rewritePreviewResponse(proxied, frameAncestor);
}

export default worker;

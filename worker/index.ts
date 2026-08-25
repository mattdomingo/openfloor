import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import type { D1DatabaseLike } from "../db";
import {
  cloudflareAccessIdentity,
  localDevelopmentIdentity,
  requestWithTrustedIdentity,
  type IdentityEnvironment,
} from "../lib/identity";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { purgeExpiredSessions } from "../db/sessions";
import { retirePoolSandbox, takeEvictablePoolSandboxes } from "../db/sandbox-pool";
import { notifyMembersChanged } from "../lib/presence-server";
import { handlePresenceRequest, SessionPresence } from "./presence";
import { SessionRouter } from "./session-router";
import { RepositoryPreflightWorkflow } from "./preflight-workflow";
import { AgentRunWorkflow } from "./agent-run-workflow";
export { Sandbox, ContainerProxy } from "@cloudflare/sandbox";

export { AgentRunWorkflow, RepositoryPreflightWorkflow, SessionPresence, SessionRouter };

type DurableObjectStubLike = { fetch(request: Request): Promise<Response> };
type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

interface Env extends IdentityEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1DatabaseLike;
  SANDBOX: DurableObjectNamespace<Sandbox>;
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

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const presenceResponse = await handlePresenceRequest(request, env);
    if (presenceResponse) return presenceResponse;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const asset = await serveAsset(request, env);
    if (asset) return asset;

    const identityHeaders = new Headers(request.headers);
    if (!identityHeaders.has("host")) identityHeaders.set("host", url.host);
    const identity = localDevelopmentIdentity(identityHeaders, env)
      ?? await cloudflareAccessIdentity(identityHeaders, env);
    return handler.fetch(requestWithTrustedIdentity(request, identity), env, ctx);
  },

  // Cron entry points (wrangler.jsonc triggers.crons). Thin by design: the
  // logic lives in the testable db helpers.
  async scheduled(controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = (controller as { cron?: string } | null)?.cron;
    ctx.waitUntil((async () => {
      if (cron === POOL_SWEEP_CRON) {
        await sweepSandboxPool(env);
        return;
      }
      const deletedSessionIds = await purgeExpiredSessions(env.DB);
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

export default worker;

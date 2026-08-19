import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import type { D1DatabaseLike } from "../db";
import {
  cloudflareAccessIdentity,
  localDevelopmentIdentity,
  requestWithTrustedIdentity,
  type IdentityEnvironment,
} from "../lib/identity";
import { handlePresenceRequest, SessionPresence } from "./presence";
import { RepositoryPreflightWorkflow } from "./preflight-workflow";
import { AgentRunWorkflow } from "./agent-run-workflow";
export { Sandbox, ContainerProxy } from "@cloudflare/sandbox";

export { AgentRunWorkflow, RepositoryPreflightWorkflow, SessionPresence };

type DurableObjectStubLike = { fetch(request: Request): Promise<Response> };
type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

interface Env extends IdentityEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1DatabaseLike;
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

const BASE_PATH = "/app";

async function serveAsset(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (url.pathname !== BASE_PATH && !url.pathname.startsWith(`${BASE_PATH}/`)) return null;
  const stripped = new URL(url);
  stripped.pathname = url.pathname.slice(BASE_PATH.length) || "/";
  const asset = await env.ASSETS.fetch(new Request(stripped, request));
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

    const asset = await serveAsset(request, env, url);
    if (asset) return asset;

    const identityHeaders = new Headers(request.headers);
    if (!identityHeaders.has("host")) identityHeaders.set("host", url.host);
    const identity = localDevelopmentIdentity(identityHeaders, env)
      ?? await cloudflareAccessIdentity(identityHeaders, env);
    return handler.fetch(requestWithTrustedIdentity(request, identity), env, ctx);
  },
};

export default worker;

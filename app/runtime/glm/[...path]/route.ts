import { handleAnthropicCompatProxy, logAndConcealGet } from "@/lib/anthropic-compat-gateway";

// Z.ai's Anthropic-compat surface (Spike A, 2026-08-24, rerun on the funded
// account): POST /api/anthropic/v1/messages accepts both `authorization:
// Bearer` and `x-api-key` (Bearer is what the gateway sends, matching the
// documented form and the SDK's own traffic); SSE framing matches
// Anthropic's; and — unlike Moonshot's 404 — count_tokens is a real 200
// upstream, so the allowlisted probe genuinely works. glm-5.3 always thinks
// (bare requests get 400 code 1210), but the CLI natively sends
// thinking:{type:"adaptive"}, which Z.ai accepts — only hand-built smoke
// tests need to remember it.
const ALLOWED_PATHS = new Set(["messages", "messages/count_tokens"]);

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return handleAnthropicCompatProxy(request, params, {
    operation: "glm",
    provider: "glm",
    upstreamBase: "https://api.z.ai/api/anthropic/v1",
    serverKeyBinding: "ZAI_API_KEY",
    buildAuthHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    allowedPaths: ALLOWED_PATHS,
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return logAndConcealGet("glm", params);
}

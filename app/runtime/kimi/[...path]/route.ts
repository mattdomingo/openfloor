import { handleAnthropicCompatProxy, logAndConcealGet } from "@/lib/anthropic-compat-gateway";

// Moonshot's Anthropic-compat surface (Spike A, 2026-08-24): POST
// /anthropic/v1/messages accepts both `authorization: Bearer` and
// `x-api-key` (Bearer is the documented form the gateway sends), SSE framing
// matches Anthropic's, and count_tokens 404s upstream — kept in the allowlist
// so the CLI's probe degrades on the vendor's answer, not on concealment.
const ALLOWED_PATHS = new Set(["messages", "messages/count_tokens"]);

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return handleAnthropicCompatProxy(request, params, {
    operation: "kimi",
    provider: "kimi",
    upstreamBase: "https://api.moonshot.ai/anthropic/v1",
    serverKeyBinding: "MOONSHOT_API_KEY",
    buildAuthHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    allowedPaths: ALLOWED_PATHS,
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return logAndConcealGet("kimi", params);
}

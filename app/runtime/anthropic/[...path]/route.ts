import { handleAnthropicCompatProxy, logAndConcealGet } from "@/lib/anthropic-compat-gateway";

// Finalized from observed traffic during the rollout spike — rejected paths
// are logged by the shared handler specifically so this list is grown from
// evidence, not spec.
const ALLOWED_PATHS = new Set(["messages", "messages/count_tokens"]);

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return handleAnthropicCompatProxy(request, params, {
    operation: "anthropic",
    provider: "anthropic",
    upstreamBase: "https://api.anthropic.com/v1",
    serverKeyBinding: "ANTHROPIC_API_KEY",
    // api_key rows (and the server key) go upstream as x-api-key; a
    // subscription setup token authenticates as `authorization: Bearer` plus
    // the oauth beta flag the handler merges (Spike C, 2026-08-24: those two
    // transport-header changes are the complete oauth delta — body and
    // system blocks are byte-identical between modes).
    buildAuthHeaders: (secret, kind): Record<string, string> =>
      kind === "oauth" ? { authorization: `Bearer ${secret}` } : { "x-api-key": secret },
    allowedPaths: ALLOWED_PATHS,
    oauthBetaFlag: "oauth-2025-04-20",
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return logAndConcealGet("anthropic", params);
}

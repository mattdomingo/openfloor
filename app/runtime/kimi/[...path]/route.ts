import { handleAnthropicCompatProxy, logAndConcealGet } from "@/lib/anthropic-compat-gateway";

// Moonshot's Anthropic-compat surface (Spike A, 2026-08-24): POST
// /anthropic/v1/messages accepts both `authorization: Bearer` and
// `x-api-key` (Bearer is the documented form the gateway sends), SSE framing
// matches Anthropic's, and count_tokens 404s upstream — kept in the allowlist
// so the CLI's probe degrades on the vendor's answer, not on concealment.
//
// A Kimi Code plan key (kind oauth) is served from a different host: the
// vendor's Claude Code guide says ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
// with the key in ANTHROPIC_API_KEY — the x-api-key form — so oauth-kind
// resolutions swap both the upstream base and the auth header. Probed
// 2026-08-26: the plan base parses both header forms (an invalid key gets
// 401 invalid_authentication_error either way) and rejects PAYG keys
// outright, so the two credential universes cannot cross-bill. The plan
// surface itself is vendor-documented but not purchased-plan-verified (the
// waitlist blocked a spike account); production members' runs are the
// acceptance — see the 2026-08-26 decision-log entry.
const ALLOWED_PATHS = new Set(["messages", "messages/count_tokens"]);

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return handleAnthropicCompatProxy(request, params, {
    operation: "kimi",
    provider: "kimi",
    upstreamBase: "https://api.moonshot.ai/anthropic/v1",
    oauthUpstreamBase: "https://api.kimi.com/coding/v1",
    buildAuthHeaders: (secret, kind): Record<string, string> =>
      kind === "oauth" ? { "x-api-key": secret } : { authorization: `Bearer ${secret}` },
    allowedPaths: ALLOWED_PATHS,
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return logAndConcealGet("kimi", params);
}

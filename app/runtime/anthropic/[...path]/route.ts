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
    buildAuthHeaders: (apiKey) => ({ "x-api-key": apiKey }),
    allowedPaths: ALLOWED_PATHS,
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return logAndConcealGet("anthropic", params);
}

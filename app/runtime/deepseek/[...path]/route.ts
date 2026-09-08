import { logAndConcealGet } from "@/lib/anthropic-compat-gateway";
import { handleOpenAiChatCompatProxy } from "@/lib/openai-chat-compat-gateway";

// DeepSeek's OpenAI-compatible API — the qwen route with a different
// upstream and secret, verbatim the Kimi→GLM recipe: the same Qwen Code
// runner speaks chat completions to both. Wire behavior against the real
// vendor is Spike D1 — see docs/qwen-deepseek-provider-prompt.md.
const ALLOWED_PATHS = new Set(["chat/completions"]);

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return handleOpenAiChatCompatProxy(request, params, {
    operation: "deepseek",
    provider: "deepseek",
    upstreamBase: "https://api.deepseek.com",
    allowedPaths: ALLOWED_PATHS,
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return logAndConcealGet("deepseek", params);
}

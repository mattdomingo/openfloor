import { logAndConcealGet } from "@/lib/anthropic-compat-gateway";
import { handleOpenAiChatCompatProxy } from "@/lib/openai-chat-compat-gateway";

// Alibaba Cloud Model Studio's OpenAI-compatible surface, international
// region (the only region a Singapore-console key authenticates against —
// lib/provider-validation.ts probes the same host). The pinned Qwen Code CLI
// sends exactly one path, POST /v1/chat/completions, with `authorization:
// Bearer` (Spike Q1, 2026-08-28) — it never lists models — so that is the
// whole allowlist; GET is concealed like every other gateway. Wire behavior
// against the real vendor (SSE framing, usage in the final chunk, tool
// calls) is Spike Q2 — see docs/qwen-deepseek-provider-prompt.md.
const ALLOWED_PATHS = new Set(["chat/completions"]);

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return handleOpenAiChatCompatProxy(request, params, {
    operation: "qwen",
    provider: "qwen",
    upstreamBase: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    allowedPaths: ALLOWED_PATHS,
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return logAndConcealGet("qwen", params);
}

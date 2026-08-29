import { env } from "cloudflare:workers";
import type { CredentialProvider } from "./provider-credentials";

/** Providers whose execution runners are not enabled in this deployment. */
export function disabledRunProviders(): ReadonlySet<CredentialProvider> {
  const bindings = env as unknown as {
    CLAUDE_RUN_ENABLED?: string;
    KIMI_RUN_ENABLED?: string;
    GEMINI_RUN_ENABLED?: string;
    GLM_RUN_ENABLED?: string;
    QWEN_RUN_ENABLED?: string;
    DEEPSEEK_RUN_ENABLED?: string;
    OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string;
  };
  if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true") return new Set();
  const flags = {
    anthropic: bindings.CLAUDE_RUN_ENABLED,
    kimi: bindings.KIMI_RUN_ENABLED,
    gemini: bindings.GEMINI_RUN_ENABLED,
    glm: bindings.GLM_RUN_ENABLED,
    qwen: bindings.QWEN_RUN_ENABLED,
    deepseek: bindings.DEEPSEEK_RUN_ENABLED,
  } as const;
  return new Set(
    (Object.keys(flags) as Array<keyof typeof flags>).filter((provider) => flags[provider] !== "true"),
  );
}

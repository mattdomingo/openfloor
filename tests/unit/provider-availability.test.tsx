import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderCredentials } from "@/components/product/ProviderCredentials";
import type { ProviderCredentialSummary } from "@/lib/provider-credentials";

describe("provider availability", () => {
  it("does not offer disabled unconfigured providers", () => {
    const html = renderToStaticMarkup(<ProviderCredentials initialCredentials={[]} providers={["openai"]} />);
    expect(html).not.toContain("DeepSeek");
    expect(html).toContain("OpenAI");
  });
  it("retains a disabled saved credential with an explicit unavailable state", () => {
    const credential = { provider: "deepseek", kind: "api_key", fingerprint: "1234", validatedAt: 1 } as ProviderCredentialSummary;
    const html = renderToStaticMarkup(<ProviderCredentials initialCredentials={[credential]} providers={["openai"]} />);
    expect(html).toContain("DeepSeek");
    expect(html).toContain("Unavailable in this environment");
  });
});

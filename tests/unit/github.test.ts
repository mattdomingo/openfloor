import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  importGitHubAppPrivateKey,
  listInstallationRepositories,
  type GitHubAppConfig,
} from "@/lib/github";

describe("GitHub App client", () => {
  it("accepts the PKCS#1 PEM format downloaded from GitHub", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    await expect(importGitHubAppPrivateKey(privateKey)).resolves.toMatchObject({
      algorithm: { name: "RSASSA-PKCS1-v1_5" },
      type: "private",
    });
  });

  it("turns a malformed private key into a bounded API error", async () => {
    const config: GitHubAppConfig = {
      appId: "1",
      slug: "openfloor-test",
      privateKey: "not-a-private-key",
      stateSecret: "state-secret",
      webhookSecret: "webhook-secret",
      testData: null,
    };

    await expect(listInstallationRepositories(config, "123")).rejects.toMatchObject({
      name: "GitHubApiError",
      status: 500,
      message: "GitHub App private key could not be read",
    });
  });
});

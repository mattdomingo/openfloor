import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  createRepositoryBranch,
  deleteTestRepositoryBranchIfMatches,
  getRepositoryRefSha,
  importGitHubAppPrivateKey,
  listInstallationRepositories,
  type GitHubAppConfig,
} from "@/lib/github";
import { githubGitAuthorization } from "@/lib/github-git-auth";

describe("GitHub App client", () => {
  it("encodes installation tokens for Git-over-HTTPS basic authentication", () => {
    expect(githubGitAuthorization("ghs_example-token")).toBe(
      `Authorization: Basic ${btoa("x-access-token:ghs_example-token")}`,
    );
    expect(() => githubGitAuthorization("bad\ntoken")).toThrow("Invalid GitHub installation token");
  });

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

  it("deletes only an OpenFloor test ref whose head still matches", async () => {
    const repository = { id: "1", nodeId: "R_1", owner: "openfloor", name: "test", fullName: "openfloor/test", private: true, defaultBranch: "main" };
    const config: GitHubAppConfig = {
      appId: "1", slug: "openfloor-test", privateKey: "test", stateSecret: "state", webhookSecret: "webhook",
      testData: { installationId: "installation", repositories: [{ ...repository, branches: ["main"] }] },
    };
    const branch = "openfloor/session1/run/run1";
    const sha = "a".repeat(40);
    await createRepositoryBranch(config, "installation", repository, branch, sha);
    await expect(deleteTestRepositoryBranchIfMatches(config, "installation", repository, branch, "b".repeat(40))).resolves.toBe(false);
    await expect(getRepositoryRefSha(config, "installation", repository, branch)).resolves.toBe(sha);
    await expect(deleteTestRepositoryBranchIfMatches(config, "installation", repository, branch, sha)).resolves.toBe(true);
    await expect(getRepositoryRefSha(config, "installation", repository, branch)).rejects.toMatchObject({ status: 404 });
  });
});

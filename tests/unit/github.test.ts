import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  createRepositoryBranch,
  createDraftPullRequest,
  deleteTestRepositoryBranchIfMatches,
  getPullRequestReview,
  getRepositoryFileContent,
  getRepositoryRefSha,
  importGitHubAppPrivateKey,
  listInstallationRepositories,
  listRepositoryTree,
  mergeRepositoryBranch,
  markPullRequestReadyForReview,
  squashMergePullRequest,
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

  it("deletes only an openfloor test ref whose head still matches", async () => {
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

  it("serially advances a candidate and reuses one draft pull request", async () => {
    const repository = { id: "phase6", nodeId: "R_6", owner: "openfloor", name: "phase6", fullName: "openfloor/phase6", private: true, defaultBranch: "main" };
    const config: GitHubAppConfig = {
      appId: "1", slug: "openfloor-test", privateKey: "test", stateSecret: "state", webhookSecret: "webhook",
      testData: { installationId: "installation-6", repositories: [{ ...repository, branches: ["main"], branchShas: { main: "1".repeat(40) } }] },
    };
    const candidate = "openfloor/session/candidate/phase6";
    await createRepositoryBranch(config, "installation-6", repository, candidate, "1".repeat(40));
    const merged = await mergeRepositoryBranch(config, "installation-6", repository, candidate, "2".repeat(40), "Integrate run");
    expect(merged.sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(getRepositoryRefSha(config, "installation-6", repository, candidate)).resolves.toBe(merged.sha);
    const input = { title: "Candidate", body: "Body", head: candidate, base: "main" };
    const first = await createDraftPullRequest(config, "installation-6", repository, input);
    const second = await createDraftPullRequest(config, "installation-6", repository, input);
    expect(first).toEqual(second);
    expect(first).toEqual(expect.objectContaining({ draft: true, state: "open" }));
    const draft = await getPullRequestReview(config, "installation-6", repository, first.number);
    expect(draft).toEqual(expect.objectContaining({ headSha: merged.sha, draft: true, mergeable: true, checksPassing: true }));
    await markPullRequestReadyForReview(config, "installation-6", repository, first.nodeId);
    expect(await getPullRequestReview(config, "installation-6", repository, first.number)).toEqual(expect.objectContaining({ draft: false }));
    const squash = await squashMergePullRequest(config, "installation-6", repository, first.number, merged.sha);
    expect(await getRepositoryRefSha(config, "installation-6", repository, "main")).toBe(squash.sha);
    expect(await getPullRequestReview(config, "installation-6", repository, first.number)).toEqual(expect.objectContaining({ merged: true, state: "closed", mergeCommitSha: squash.sha }));
    expect(await deleteTestRepositoryBranchIfMatches(config, "installation-6", repository, candidate, merged.sha)).toBe(true);
  });

  it("lists a repository tree with inferred directories and reads file contents", async () => {
    const repository = { id: "browse", nodeId: "R_browse", owner: "openfloor", name: "browse", fullName: "openfloor/browse", private: true, defaultBranch: "main" };
    const config: GitHubAppConfig = {
      appId: "1", slug: "openfloor-test", privateKey: "test", stateSecret: "state", webhookSecret: "webhook",
      testData: {
        installationId: "installation-browse",
        repositories: [{
          ...repository,
          branches: ["main"],
          files: { "README.md": "# Browse\n", "src/index.ts": "export const entry = true;\n" },
        }],
      },
    };
    const tree = await listRepositoryTree(config, "installation-browse", repository, "main");
    expect(tree.truncated).toBe(false);
    expect(tree.entries).toEqual(expect.arrayContaining([
      { path: "src", type: "dir", size: null, sha: "0".repeat(40) },
      { path: "src/index.ts", type: "file", size: expect.any(Number), sha: "0".repeat(40) },
      { path: "README.md", type: "file", size: expect.any(Number), sha: "0".repeat(40) },
    ]));

    const readme = await getRepositoryFileContent(config, "installation-browse", repository, "main", "README.md");
    expect(readme).toEqual({ path: "README.md", encoding: "text", text: "# Browse\n", size: 9, truncated: false });

    await expect(getRepositoryFileContent(config, "installation-browse", repository, "main", "missing.txt"))
      .rejects.toMatchObject({ status: 404 });
    await expect(getRepositoryFileContent(config, "installation-browse", repository, "main", "../escape.txt"))
      .rejects.toMatchObject({ status: 400 });
    await expect(listRepositoryTree(config, "installation-browse", repository, "../main"))
      .rejects.toMatchObject({ status: 400 });
    await expect(listRepositoryTree(config, "wrong-installation", repository, "main"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("classifies binary and oversized file content without decoding past the cap", async () => {
    const repository = { id: "blobs", nodeId: "R_blobs", owner: "openfloor", name: "blobs", fullName: "openfloor/blobs", private: true, defaultBranch: "main" };
    const large = "x".repeat(512 * 1024 + 1);
    const config: GitHubAppConfig = {
      appId: "1", slug: "openfloor-test", privateKey: "test", stateSecret: "state", webhookSecret: "webhook",
      testData: {
        installationId: "installation-blobs",
        repositories: [{
          ...repository,
          branches: ["main"],
          files: { "image.bin": " binary", "large.txt": large },
        }],
      },
    };
    await expect(getRepositoryFileContent(config, "installation-blobs", repository, "main", "image.bin"))
      .resolves.toMatchObject({ encoding: "binary" });
    await expect(getRepositoryFileContent(config, "installation-blobs", repository, "main", "large.txt"))
      .resolves.toMatchObject({ encoding: "too_large" });
  });
});

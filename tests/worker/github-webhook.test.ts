import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POST as receiveGitHubWebhook } from "@/app/webhooks/github/route";
import {
  activateRepositoryCandidate,
  getActiveRepositoryCandidateForMember,
  reserveRepositoryCandidate,
  saveRepositoryConnection,
} from "@/db/repositories";
import { createSession, upsertUser } from "@/db/sessions";

describe("GitHub webhook reconciliation", () => {
  it("revokes and restores account installation access with installation webhooks", async () => {
    const owner = await upsertUser({
      providerUserId: "webhook-account-owner", email: "webhook-account@example.com", displayName: "Webhook Account", fullName: "Webhook Account",
    }, env.DB);
    await env.DB.prepare(
      `INSERT INTO user_github_installations
       (id, user_id, installation_id, account_login, account_type, status, connected_at, updated_at)
       VALUES (?, ?, 'installation-account-webhook', 'openfloor', 'Organization', 'active', ?, ?)`,
    ).bind(crypto.randomUUID(), owner.id, Date.now(), Date.now()).run();
    for (const [delivery, action, status] of [
      ["delivery-account-suspend", "suspend", "revoked"],
      ["delivery-account-unsuspend", "unsuspend", "active"],
    ] as const) {
      const body = JSON.stringify({ action, installation: { id: "installation-account-webhook" } });
      const response = await receiveGitHubWebhook(webhookRequest(body, delivery, await sign(body), "installation"));
      expect(response.status).toBe(202);
      const row = await env.DB.prepare(
        "SELECT status FROM user_github_installations WHERE user_id = ? AND installation_id = 'installation-account-webhook'",
      ).bind(owner.id).first<{ status: string }>();
      expect(row?.status).toBe(status);
    }
  });

  it("rejects invalid signatures and applies a delivery only once", async () => {
    const owner = await upsertUser({
      providerUserId: "webhook-owner", email: "webhook@example.com", displayName: "Webhook Owner", fullName: "Webhook Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Webhook room", objective: null }, env.DB);
    const connection = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-webhook", {
      id: "repository-webhook", nodeId: "R_webhook", owner: "openfloor", name: "test",
      fullName: "openfloor/test", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, connection!.id, candidateId, "Webhook room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    const body = JSON.stringify({
      installation: { id: "installation-webhook" }, repository: { id: "repository-webhook" },
      ref: "refs/heads/main", after: "b".repeat(40),
    });
    const invalid = await receiveGitHubWebhook(webhookRequest(body, "delivery-webhook", "sha256=invalid"));
    expect(invalid.status).toBe(401);
    const signature = await sign(body);
    const accepted = await receiveGitHubWebhook(webhookRequest(body, "delivery-webhook", signature));
    expect(accepted.status).toBe(202);
    expect(await getActiveRepositoryCandidateForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ behindBase: true }));
    const revision = await env.DB.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(created.session.id).first<{ revision: number }>();
    const duplicate = await receiveGitHubWebhook(webhookRequest(body, "delivery-webhook", signature));
    expect(await duplicate.json()).toEqual(expect.objectContaining({ duplicate: true }));
    const afterReplay = await env.DB.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(created.session.id).first<{ revision: number }>();
    expect(afterReplay?.revision).toBe(revision?.revision);
  });

  it("ends the session when the candidate branch merges on GitHub, but not when another branch merges", async () => {
    const owner = await upsertUser({
      providerUserId: "webhook-merge-owner", email: "webhook-merge@example.com", displayName: "Webhook Merge Owner", fullName: "Webhook Merge Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Merge webhook room", objective: null }, env.DB);
    const connection = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-merge-webhook", {
      id: "repository-merge-webhook", nodeId: "R_merge_webhook", owner: "openfloor", name: "merge-test",
      fullName: "openfloor/merge-test", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, connection!.id, candidateId, "Merge webhook room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    const otherBranchBody = JSON.stringify({
      installation: { id: "installation-merge-webhook" }, repository: { id: "repository-merge-webhook" },
      pull_request: {
        number: 1, node_id: "PR_other", html_url: "https://github.com/openfloor/merge-test/pull/1",
        state: "closed", draft: false, merged: true, merge_commit_sha: "b".repeat(40), head: { ref: "some-other-branch" },
      },
    });
    const otherBranchResponse = await receiveGitHubWebhook(webhookRequest(otherBranchBody, "delivery-merge-other", await sign(otherBranchBody), "pull_request"));
    expect(otherBranchResponse.status).toBe(202);
    const stillLive = await env.DB.prepare("SELECT ended_at AS endedAt FROM sessions WHERE id = ?").bind(created.session.id).first<{ endedAt: number | null }>();
    expect(stillLive?.endedAt).toBeNull();

    const mergeBody = JSON.stringify({
      installation: { id: "installation-merge-webhook" }, repository: { id: "repository-merge-webhook" },
      pull_request: {
        number: 2, node_id: "PR_candidate", html_url: "https://github.com/openfloor/merge-test/pull/2",
        state: "closed", draft: false, merged: true, merge_commit_sha: "c".repeat(40), head: { ref: branch },
      },
    });
    const signature = await sign(mergeBody);
    const mergeResponse = await receiveGitHubWebhook(webhookRequest(mergeBody, "delivery-merge-candidate", signature, "pull_request"));
    expect(mergeResponse.status).toBe(202);
    const ended = await env.DB.prepare("SELECT ended_at AS endedAt, ended_reason AS endedReason FROM sessions WHERE id = ?").bind(created.session.id).first<{ endedAt: number | null; endedReason: string | null }>();
    expect(ended?.endedAt).not.toBeNull();
    expect(ended?.endedReason).toBe("merged");
    const candidateRow = await env.DB.prepare("SELECT merged_at AS mergedAt, pull_request_merged AS pullRequestMerged FROM repository_candidates WHERE id = ?").bind(candidateId).first<{ mergedAt: number | null; pullRequestMerged: number }>();
    expect(candidateRow?.mergedAt).not.toBeNull();
    expect(candidateRow?.pullRequestMerged).toBe(1);

    const duplicate = await receiveGitHubWebhook(webhookRequest(mergeBody, "delivery-merge-candidate", signature, "pull_request"));
    expect(await duplicate.json()).toEqual(expect.objectContaining({ duplicate: true }));
    const afterReplay = await env.DB.prepare("SELECT ended_at AS endedAt FROM sessions WHERE id = ?").bind(created.session.id).first<{ endedAt: number | null }>();
    expect(afterReplay?.endedAt).toBe(ended?.endedAt);
  });
});

function webhookRequest(body: string, delivery: string, signature: string, event = "push"): Request {
  return new Request("https://app.opnflr.com/webhooks/github", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signature },
    body,
  });
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("worker-test-github-webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

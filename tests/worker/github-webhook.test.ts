import { linkUserGitHubInstallation, listUserGitHubInstallations, refreshUserGitHubInstallations } from "@/db/github-installations";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POST as receiveGitHubWebhook } from "@/app/webhooks/github/route";
import {
  activateRepositoryCandidate,
  getActiveRepositoryCandidateForMember,
  recordGitHubWebhookDelivery,
  reserveRepositoryCandidate,
  saveRepositoryConnection,
} from "@/db/repositories";
import { createFloorAgent, createFloorQueueItem, pauseFloorAgent } from "@/db/floor";
import { createSession, setSessionRoutingSettings, upsertUser } from "@/db/sessions";
import { setTestPullRequestFeedback } from "@/lib/github";
import { parseAgentInput } from "@/lib/validation";

describe("GitHub webhook reconciliation", () => {
  it("refreshes verified scopes without disconnecting or widening another member's access", async () => {
    const owner = await upsertUser({ providerUserId: "refresh-owner", email: "refresh-owner@example.com", displayName: "Owner", fullName: "Owner" }, env.DB);
    const member = await upsertUser({ providerUserId: "refresh-member", email: "refresh-member@example.com", displayName: "Member", fullName: "Member" }, env.DB);
    const account = { login: "team", type: "Organization" };
    await linkUserGitHubInstallation(owner.id, "refresh-installation", account, ["old"], env.DB);
    await linkUserGitHubInstallation(member.id, "refresh-installation", account, ["member-only"], env.DB);
    await linkUserGitHubInstallation(owner.id, "other-account", account, ["other"], env.DB);
    const before = await listUserGitHubInstallations(owner.id, env.DB);
    await refreshUserGitHubInstallations(owner.id, [{ id: "refresh-installation", account, repoScope: ["old", "added"] }], env.DB);
    const readScope = (id: string) => env.DB.prepare("SELECT id, repo_scope AS scope FROM user_github_installations WHERE user_id = ? AND installation_id = 'refresh-installation'").bind(id).first<{ id: string; scope: string }>();
    expect(JSON.parse((await readScope(owner.id))!.scope)).toEqual(["old", "added"]);
    expect((await listUserGitHubInstallations(owner.id, env.DB)).map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(JSON.parse((await readScope(member.id))!.scope)).toEqual(["member-only"]);
    await refreshUserGitHubInstallations(owner.id, [{ id: "refresh-installation", account, repoScope: [] }], env.DB);
    expect(JSON.parse((await readScope(owner.id))!.scope)).toEqual([]);
    expect(await listUserGitHubInstallations(owner.id, env.DB)).toHaveLength(1);
  });

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

describe("GitHub PR feedback nudges", () => {
  it("turns CI failures and review comments on the candidate PR into router-originated queue items", async () => {
    const owner = await upsertUser({
      providerUserId: "webhook-feedback-owner", email: "webhook-feedback@example.com", displayName: "Feedback Owner", fullName: "Feedback Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Feedback room", objective: null }, env.DB);
    const repository = { id: "repository-feedback", nodeId: "R_feedback", owner: "openfloor", name: "feedback", fullName: "openfloor/feedback", private: true, defaultBranch: "main" };
    const connection = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-feedback", repository, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    const sha = "a".repeat(40);
    await reserveRepositoryCandidate(created.session.id, owner.id, connection!.id, candidateId, "Feedback room", "", branch, "main", sha, env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, sha, env.DB);
    await env.DB.prepare(
      "UPDATE repository_candidates SET pull_request_number = 7, pull_request_node_id = 'PR_7', pull_request_url = ?, pull_request_state = 'open' WHERE id = ?",
    ).bind("https://github.com/openfloor/feedback/pull/7", candidateId).run();
    const parsed = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement the request", ownerUserId: owner.id });
    if (!parsed) throw new Error("Invalid agent fixture");
    let floor = await createFloorAgent(created.session.id, owner.id, parsed, env.DB);
    const agentId = floor!.agents[0].id;
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Add a file", agentId }, env.DB);
    const humanItemId = floor!.queue[0].id;
    // One integrated run by Builder that touched src/a.ts — the responsible run.
    const runId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO agent_runs
        (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, run_branch, attempt, status, model, sandbox_id,
         integrated_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'openfloor/run/one', 1, 'integrated', 'gpt-test', 'sandbox', ?, ?, ?, ?)`,
    ).bind(runId, created.session.id, humanItemId, agentId, candidateId, sha, now, owner.id, now, now).run();
    await env.DB.prepare(
      `INSERT INTO agent_run_files (id, run_id, path, change_kind, additions, deletions, summary, diff_preview, created_at)
       VALUES (?, ?, 'src/a.ts', 'update', 1, 1, NULL, '', ?)`,
    ).bind(crypto.randomUUID(), runId, now).run();
    await env.DB.prepare("UPDATE floor_queue_items SET status = 'completed' WHERE id = ?").bind(humanItemId).run();

    const nudges = async () => (await env.DB.prepare(
      `SELECT id, agent_id AS agentId, status, assigned_by AS assignedBy, intent, origin, source_run_id AS sourceRunId
       FROM floor_queue_items WHERE session_id = ? AND origin IS NOT NULL ORDER BY position`,
    ).bind(created.session.id).all<{ id: string; agentId: string | null; status: string; assignedBy: string | null; intent: string | null; origin: string; sourceRunId: string | null }>()).results;
    const promptText = async (itemId: string) => env.DB.prepare("SELECT author_user_id AS authorUserId, text FROM floor_queue_prompts WHERE queue_item_id = ?")
      .bind(itemId).first<{ authorUserId: string; text: string }>();
    const revision = async () => Number((await env.DB.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(created.session.id).first<{ revision: number }>())?.revision);
    const deliver = async (event: string, delivery: string, payload: Record<string, unknown>) => {
      const body = JSON.stringify({ installation: { id: "installation-feedback" }, repository: { id: "repository-feedback" }, ...payload });
      const response = await receiveGitHubWebhook(webhookRequest(body, delivery, await sign(body), event));
      expect(response.status).toBe(202);
    };
    const checkRun = { action: "completed", check_run: { head_sha: sha, pull_requests: [{ number: 7 }] } };
    const failing = [{ name: "build", status: "failure", url: "https://ci.example/1" }];
    const comment = (id: string, body: string) => ({ id, author: "reviewer", body, path: "src/a.ts", line: 3, url: `https://github.com/openfloor/feedback/pull/7#discussion_r${id}` });

    const bindings = env as unknown as Record<string, unknown>;
    const previousFixture = bindings.OPENFLOOR_TEST_GITHUB_DATA;
    bindings.OPENFLOOR_TEST_GITHUB_DATA = JSON.stringify({ installationId: "installation-feedback", repositories: [{ ...repository, branches: ["main"] }] });
    try {
      // A completed failing check queues one CI nudge for the responsible agent.
      setTestPullRequestFeedback("repository-feedback", 7, { headSha: sha, failedChecks: failing });
      await deliver("check_run", "delivery-feedback-ci-1", checkRun);
      let rows = await nudges();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ origin: "ci_failure", intent: "task", status: "queued", agentId, assignedBy: "router", sourceRunId: runId }));
      const ciPrompt = await promptText(rows[0].id);
      expect(ciPrompt?.authorUserId).toBe(owner.id);
      expect(ciPrompt?.text).toContain("CI is failing on PR #7");
      expect(ciPrompt?.text).toContain("Failed: build (failure)");
      const state = await env.DB.prepare("SELECT feedback_nudges AS feedbackNudges FROM repository_candidates WHERE id = ?").bind(candidateId).first<{ feedbackNudges: string }>();
      expect(JSON.parse(state!.feedbackNudges).ci_failure).toEqual(expect.objectContaining({ attempts: 1, queueItemId: rows[0].id }));

      // The same facts redelivered do not create a second item; the revision still moves.
      const beforeRedelivery = await revision();
      await deliver("check_run", "delivery-feedback-ci-2", checkRun);
      expect(await nudges()).toHaveLength(1);
      expect(await revision()).toBeGreaterThan(beforeRedelivery);

      // A review comment on a path the paused agent last changed goes out unassigned but still names its run.
      await pauseFloorAgent(created.session.id, owner.id, agentId, true, env.DB);
      setTestPullRequestFeedback("repository-feedback", 7, { headSha: sha, failedChecks: failing, unresolvedThreads: [{ threadId: "T1", comments: [comment("1", "Rename this")] }] });
      await deliver("pull_request_review_comment", "delivery-feedback-review-1", { action: "created", pull_request: { number: 7, node_id: "PR_7" } });
      rows = await nudges();
      expect(rows).toHaveLength(2);
      const review = rows.find((row) => row.origin === "review_comments")!;
      expect(review).toEqual(expect.objectContaining({ status: "queued", agentId: null, assignedBy: null, sourceRunId: runId }));

      // A newer comment while that item is still queued updates it in place, and the resumed agent picks it up.
      await pauseFloorAgent(created.session.id, owner.id, agentId, false, env.DB);
      setTestPullRequestFeedback("repository-feedback", 7, { headSha: sha, failedChecks: failing, unresolvedThreads: [{ threadId: "T1", comments: [comment("1", "Rename this"), comment("2", "And this")] }] });
      await deliver("pull_request_review_comment", "delivery-feedback-review-2", { action: "created", pull_request: { number: 7, node_id: "PR_7" } });
      rows = await nudges();
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.origin === "review_comments")).toEqual(expect.objectContaining({ id: review.id, agentId, assignedBy: "router" }));
      expect((await promptText(review.id))?.text).toContain("2 unresolved review comments");

      // With the owner toggle off, a brand-new CI failure queues nothing; the revision still bumps.
      await setSessionRoutingSettings(created.session.id, owner.id, { autoInjectFeedback: false }, env.DB);
      setTestPullRequestFeedback("repository-feedback", 7, { headSha: "b".repeat(40), failedChecks: [{ name: "lint", status: "failure", url: null }] });
      const beforeOff = await revision();
      await deliver("check_run", "delivery-feedback-ci-3", checkRun);
      expect(await nudges()).toHaveLength(2);
      expect(await revision()).toBeGreaterThan(beforeOff);
    } finally {
      bindings.OPENFLOOR_TEST_GITHUB_DATA = previousFixture;
    }
  });

  it("releases the delivery claim when processing throws so GitHub can redeliver the same ID", async () => {
    const owner = await upsertUser({
      providerUserId: "webhook-retry-owner", email: "webhook-retry@example.com", displayName: "Webhook Retry", fullName: "Webhook Retry",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Webhook retry room", objective: null }, env.DB);
    const connection = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-retry", {
      id: "repository-retry", nodeId: "R_retry", owner: "openfloor", name: "retry",
      fullName: "openfloor/retry", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, connection!.id, candidateId, "Webhook retry room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    // A signed but malformed payload fails inside the per-target effect loop,
    // standing in for any mid-processing failure.
    const body = JSON.stringify({
      installation: { id: "installation-retry" }, repository: { id: "repository-retry" },
      action: "removed", repositories_removed: "not-an-array",
    });
    await expect(receiveGitHubWebhook(
      webhookRequest(body, "delivery-retry", await sign(body), "installation_repositories"),
    )).rejects.toThrow();
    // The claim is gone, so a signed redelivery of the same ID is fresh again.
    expect(await recordGitHubWebhookDelivery("delivery-retry", "installation_repositories", "removed", "installation-retry", "repository-retry", env.DB)).toBe(true);
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

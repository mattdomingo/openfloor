import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  createSession,
  getActiveInviteId,
  getInvitePreview,
  getSessionMembers,
  leaveSession,
  listSessionsForUser,
  revokeInvite,
  rotateInvite,
  updateSessionObjective,
  upsertUser,
} from "@/db/sessions";
import {
  consumeGitHubConnectionState,
  createGitHubConnectionState,
  disconnectRepository,
  activateRepositoryCandidate,
  findRepositoryWebhookTargets,
  getActiveRepositoryCandidateForMember,
  getPendingGitHubInstallation,
  getRepositoryConnectionForMember,
  saveRepositoryConnection,
  recordGitHubWebhookDelivery,
  reserveRepositoryCandidate,
  updateRepositoryPushState,
} from "@/db/repositories";
import {
  createRepositoryPreflight,
  finishPreflightCheck,
  finishRepositoryPreflight,
  getLatestRepositoryPreflightForMember,
  getPreflightExecutionContext,
  markPreflightCheckRunning,
  markPreflightRunning,
  PreflightConflictError,
} from "@/db/preflights";
import { createFloorAgent, createFloorQueueItem, getFloorSnapshot } from "@/db/floor";
import {
  beginRunIntegration,
  AgentRunNotReadyError,
  createAgentRun,
  finishAgentRun,
  finishRunPublished,
  finishRunIntegrated,
  finishRunCheck,
  getRunExecutionContext,
  markRunChecking,
  markRunCheckRunning,
  markRunRunning,
  markRunDiscarded,
  markRunPublishing,
  markRunIntegrationConflicted,
  prepareConflictedRunRetry,
  replaceRunFiles,
  requestAgentRunCancellation,
} from "@/db/runs";
import { parseAgentInput } from "@/lib/validation";

function identity(id: string, name: string) {
  return { providerUserId: `chatgpt-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

describe("D1 session persistence", () => {
  it("upserts users by stable provider identity", async () => {
    const first = await upsertUser(identity("owner", "Owner One"), env.DB);
    const updated = await upsertUser({ ...identity("owner", "Owner Two"), email: "new@example.com" }, env.DB);

    expect(updated.id).toBe(first.id);
    expect(updated.providerUserId).toBe("chatgpt-owner");
    expect(updated.displayName).toBe("Owner Two");
    expect(updated.email).toBe("new@example.com");
  });

  it("creates and lists only the current user's sessions", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const outsider = await upsertUser(identity("outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Persistent room", objective: "Ship sessions" }, env.DB);

    expect(await listSessionsForUser(outsider.id, env.DB)).toEqual([]);
    expect(await listSessionsForUser(owner.id, env.DB)).toEqual([
      expect.objectContaining({ id: created.session.id, role: "owner", memberCount: 1 }),
    ]);
  });

  it("accepts invites idempotently and enforces one membership", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const member = await upsertUser(identity("member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);

    await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);
    await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);
    const members = await getSessionMembers(created.session.id, owner.id, env.DB);
    expect(members).toHaveLength(2);
    expect(members?.map((item) => item.role)).toEqual(["owner", "member"]);
  });

  it("rotates and revokes reusable invites", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    const nextInvite = await rotateInvite(created.session.id, owner.id, env.DB);

    expect(nextInvite).not.toBe(created.inviteId);
    expect(await getInvitePreview(created.inviteId, env.DB)).toBeNull();
    expect(await getActiveInviteId(created.session.id, owner.id, env.DB)).toBe(nextInvite);
    expect(await revokeInvite(created.session.id, owner.id, env.DB)).toBe(true);
    expect(await getActiveInviteId(created.session.id, owner.id, env.DB)).toBeNull();
  });

  it("allows members to leave but prevents owner departure", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const member = await upsertUser(identity("member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(leaveSession(created.session.id, owner.id, env.DB)).resolves.toBe("owner");
    await expect(leaveSession(created.session.id, member.id, env.DB)).resolves.toBe("left");
    await expect(leaveSession(created.session.id, member.id, env.DB)).resolves.toBe("missing");
  });

  it("allows members to update the objective and conceals the session from outsiders", async () => {
    const owner = await upsertUser(identity("objective-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("objective-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("objective-outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: "First" }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    const updated = await updateSessionObjective(created.session.id, member.id, "Second", env.DB);
    expect(updated).toEqual(expect.objectContaining({ objective: "Second", role: "member" }));
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.session.updatedAt);
    await expect(updateSessionObjective(created.session.id, outsider.id, "Hidden", env.DB)).resolves.toBeNull();
  });

  it("persists one owner-configured repository connection and ordered checks", async () => {
    const owner = await upsertUser(identity("repo-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("repo-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("repo-outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Repository room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(createGitHubConnectionState(created.session.id, member.id, env.DB)).resolves.toBeNull();
    const stateId = await createGitHubConnectionState(created.session.id, owner.id, env.DB);
    expect(stateId).toBeTruthy();
    await expect(consumeGitHubConnectionState(stateId!, outsider.id, "installation-1", env.DB)).resolves.toBeNull();
    await expect(consumeGitHubConnectionState(stateId!, owner.id, "installation-1", env.DB)).resolves.toEqual({ sessionId: created.session.id });
    await expect(consumeGitHubConnectionState(stateId!, owner.id, "installation-1", env.DB)).resolves.toBeNull();
    await expect(getPendingGitHubInstallation(created.session.id, owner.id, env.DB)).resolves.toEqual({ stateId, installationId: "installation-1" });

    const saved = await saveRepositoryConnection(
      created.session.id,
      owner.id,
      stateId,
      "installation-1",
      {
        id: "repository-1",
        nodeId: "R_node",
        owner: "openfloor-test",
        name: "repository-integration",
        fullName: "openfloor-test/repository-integration",
        private: true,
        defaultBranch: "main",
      },
      "main",
      ["npm test", "npm run build"],
      env.DB,
    );
    expect(saved).toEqual(expect.objectContaining({
      repositoryId: "repository-1",
      repositoryFullName: "openfloor-test/repository-integration",
      status: "connected",
    }));
    expect(saved?.checkCommands.map((item) => item.command)).toEqual(["npm test", "npm run build"]);
    await expect(getRepositoryConnectionForMember(created.session.id, member.id, env.DB)).resolves.toEqual(saved);
    await expect(getRepositoryConnectionForMember(created.session.id, outsider.id, env.DB)).resolves.toBeNull();
    await expect(disconnectRepository(created.session.id, member.id, env.DB)).resolves.toBeNull();
    await expect(disconnectRepository(created.session.id, owner.id, env.DB)).resolves.toEqual(expect.objectContaining({ status: "disconnected" }));
  });

  it("persists one active candidate and reconciles webhook pushes idempotently", async () => {
    const owner = await upsertUser(identity("candidate-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Candidate room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-2", {
      id: "repository-2", nodeId: "R_two", owner: "openfloor-test", name: "candidate",
      fullName: "openfloor-test/candidate", private: true, defaultBranch: "main",
    }, "main", [], env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, branch, "main", "a".repeat(40), env.DB)).resolves.toBe(true);
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, crypto.randomUUID(), `${branch}x`, "main", "a".repeat(40), env.DB)).resolves.toBe(false);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    expect(await getActiveRepositoryCandidateForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ branchName: branch, behindBase: false }));

    await expect(recordGitHubWebhookDelivery("delivery-1", "push", null, "installation-2", "repository-2", env.DB)).resolves.toBe(true);
    await expect(recordGitHubWebhookDelivery("delivery-1", "push", null, "installation-2", "repository-2", env.DB)).resolves.toBe(false);
    const [target] = await findRepositoryWebhookTargets("installation-2", "repository-2", env.DB);
    await updateRepositoryPushState(target.sessionId, "refs/heads/main", "b".repeat(40), target.baseBranch, target.candidateBranch, target.candidateSha, target.integrationRunId, env.DB);
    expect(await getActiveRepositoryCandidateForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ behindBase: true, remoteBaseSha: "b".repeat(40) }));
    await updateRepositoryPushState(target.sessionId, `refs/heads/${branch}`, "c".repeat(40), target.baseBranch, target.candidateBranch, target.candidateSha, target.integrationRunId, env.DB);
    expect(await getRepositoryConnectionForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ status: "externally_modified" }));
  });

  it("persists recoverable preflight and ordered check state", async () => {
    const owner = await upsertUser(identity("preflight-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Preflight room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-preflight", {
      id: "repository-preflight", nodeId: "R_preflight", owner: "openfloor-test", name: "preflight",
      fullName: "openfloor-test/preflight", private: true, defaultBranch: "main",
    }, "main", ["npm test", "npm run build"], env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    const preflight = await createRepositoryPreflight(created.session.id, owner.id, env.DB);
    expect(preflight.checks.map((check) => check.command)).toEqual(["npm test", "npm run build"]);
    await expect(createRepositoryPreflight(created.session.id, owner.id, env.DB)).rejects.toBeInstanceOf(PreflightConflictError);
    const context = await getPreflightExecutionContext(preflight.id, env.DB);
    await markPreflightRunning(preflight.id, env.DB);
    await markPreflightCheckRunning(preflight.id, context!.checks[0].id, env.DB);
    await finishPreflightCheck(preflight.id, context!.checks[0].id, {
      status: "passed", exitCode: 0, durationMs: 12, outputExcerpt: "ok", logKey: `preflights/${preflight.id}/checks/0.log`,
    }, env.DB);
    await finishRepositoryPreflight(preflight.id, "passed", "All checks passed", env.DB);
    expect(await getLatestRepositoryPreflightForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({
      status: "passed", checks: [expect.objectContaining({ status: "passed", hasLog: true }), expect.objectContaining({ status: "pending" })],
    }));
    const timedOut = await createRepositoryPreflight(created.session.id, owner.id, env.DB);
    await finishRepositoryPreflight(timedOut.id, "timed_out", "Required check timed out", env.DB);
    expect(await getLatestRepositoryPreflightForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ status: "timed_out" }));
  });

  it("persists owner-gated agent runs, real files, checks, retry, and cancellation", async () => {
    const owner = await upsertUser(identity("run-owner", "Run Owner"), env.DB);
    const member = await upsertUser(identity("run-member", "Run Member"), env.DB);
    const created = await createSession(owner.id, { title: "Run room", objective: "Make a focused change" }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-run", {
      id: "repository-run", nodeId: "R_run", owner: "openfloor-test", name: "run",
      fullName: "openfloor-test/run", private: true, defaultBranch: "main",
    }, "main", ["npm test"], env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, branch, "main", "d".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "d".repeat(40), env.DB);
    const parsed = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement the request", ownerUserId: owner.id });
    if (!parsed) throw new Error("Invalid agent fixture");
    let floor = await createFloorAgent(created.session.id, owner.id, parsed, env.DB);
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Add a real file", agentId: floor!.agents[0].id }, env.DB);
    const queueItemId = floor!.queue[0].id;
    await expect(createAgentRun(created.session.id, queueItemId, member.id, env.DB)).rejects.toBeInstanceOf(AgentRunNotReadyError);
    const run = await createAgentRun(created.session.id, queueItemId, owner.id, env.DB);
    expect(run).toEqual(expect.objectContaining({ status: "provisioning", model: "gpt-5.6-terra", attempt: 1 }));
    const context = await getRunExecutionContext(run.id, env.DB);
    expect(context).toEqual(expect.objectContaining({ candidateSha: "d".repeat(40), agentName: "Builder" }));
    await markRunRunning(run.id, "process-1", env.DB);
    await markRunChecking(run.id, "thread-1", "Implemented", env.DB);
    await replaceRunFiles(run.id, [{ path: "src/change.ts", changeKind: "add", additions: 1, deletions: 0, summary: null, diffPreview: "+export const changed = true;" }], env.DB);
    await markRunCheckRunning(run.id, context!.checks[0].id, env.DB);
    await finishRunCheck(run.id, context!.checks[0].id, { status: "passed", exitCode: 0, durationMs: 5, outputExcerpt: "ok", logKey: `runs/${run.id}/checks/0.log` }, env.DB);
    await finishAgentRun(run.id, "ready", "Ready locally", env.DB);
    floor = await getFloorSnapshot(created.session.id, member.id, env.DB);
    expect(floor?.queue[0].status).toBe("blocked");
    expect(floor?.runs[0]).toEqual(expect.objectContaining({ status: "ready", files: [expect.objectContaining({ path: "src/change.ts" })] }));
    expect(floor?.review).toEqual(expect.objectContaining({ id: run.id, commitSha: null }));
    const publishedSha = "e".repeat(40);
    await markRunPublishing(run.id, { bundleKey: `runs/${run.id}/result.bundle`, bundleSizeBytes: 100, localCommitSha: "f".repeat(40) }, env.DB);
    await finishRunPublished(run.id, publishedSha, publishedSha, env.DB);
    const integration = await beginRunIntegration(run.id, env.DB);
    expect(integration).toEqual(expect.objectContaining({ candidateSha: "d".repeat(40), runCommitSha: publishedSha }));
    const integratedSha = "9".repeat(40);
    await finishRunIntegrated(run.id, integratedSha, { number: 7, nodeId: "PR_7", url: "https://github.com/openfloor-test/run/pull/7", state: "open", draft: true }, env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.runs[0]).toEqual(expect.objectContaining({ status: "integrated", runCommitSha: publishedSha, integratedCandidateSha: integratedSha }));
    expect(floor?.queue[0].status).toBe("completed");
    expect(floor?.review).toEqual(expect.objectContaining({ commitSha: integratedSha, branch, pullRequest: expect.objectContaining({ number: 7, draft: true }) }));
    expect(await markRunDiscarded(created.session.id, run.id, member.id, env.DB)).toBeNull();
    expect(await markRunDiscarded(created.session.id, run.id, owner.id, env.DB)).toBeNull();
    await finishAgentRun(run.id, "failed", "Late duplicate completion", env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.queue[0].status).toBe("completed");
    expect(floor?.runs[0].status).toBe("integrated");

    await env.DB.prepare("UPDATE floor_queue_items SET status = 'queued' WHERE id = ?").bind(queueItemId).run();
    const conflict = await createAgentRun(created.session.id, queueItemId, owner.id, env.DB);
    const conflictContext = await getRunExecutionContext(conflict.id, env.DB);
    await markRunRunning(conflict.id, "process-conflict", env.DB);
    await markRunChecking(conflict.id, "thread-conflict", "Conflicting change", env.DB);
    await replaceRunFiles(conflict.id, [{ path: "src/conflict.ts", changeKind: "add", additions: 1, deletions: 0, summary: null, diffPreview: "+conflict" }], env.DB);
    await markRunCheckRunning(conflict.id, conflictContext!.checks[0].id, env.DB);
    await finishRunCheck(conflict.id, conflictContext!.checks[0].id, { status: "passed", exitCode: 0, durationMs: 5, outputExcerpt: "ok", logKey: "conflict.log" }, env.DB);
    await finishAgentRun(conflict.id, "ready", "Ready", env.DB);
    await markRunPublishing(conflict.id, { bundleKey: "conflict.bundle", bundleSizeBytes: 20, localCommitSha: "8".repeat(40) }, env.DB);
    await finishRunPublished(conflict.id, "7".repeat(40), "7".repeat(40), env.DB);
    await beginRunIntegration(conflict.id, env.DB);
    await markRunIntegrationConflicted(conflict.id, "Both runs changed src/conflict.ts", env.DB);
    expect(await prepareConflictedRunRetry(created.session.id, conflict.id, member.id, env.DB)).toBeNull();
    expect(await prepareConflictedRunRetry(created.session.id, conflict.id, owner.id, env.DB)).toBe(queueItemId);
    const retry = await createAgentRun(created.session.id, queueItemId, owner.id, env.DB);
    expect(retry.attempt).toBe(3);
    await expect(requestAgentRunCancellation(created.session.id, retry.id, member.id, env.DB)).resolves.toBeNull();
    await expect(requestAgentRunCancellation(created.session.id, retry.id, owner.id, env.DB)).resolves.toBe(true);
    await finishAgentRun(retry.id, "cancelled", "Cancelled", env.DB);
    expect((await getFloorSnapshot(created.session.id, owner.id, env.DB))?.queue[0].status).toBe("queued");
  });
});

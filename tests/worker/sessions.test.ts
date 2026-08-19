import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  createSession,
  deleteSession,
  ENDED_SESSION_RETENTION_MS,
  endSession,
  getActiveInviteId,
  getInvitePreview,
  getSessionForMember,
  getSessionMembers,
  leaveSession,
  listSessionsForUser,
  purgeExpiredSessions,
  revokeInvite,
  rotateInvite,
  SessionEndedError,
  updateSessionObjective,
  upsertUser,
} from "@/db/sessions";
import {
  consumeGitHubConnectionState,
  createGitHubConnectionState,
  disconnectRepository,
  activateRepositoryCandidate,
  findRepositoryWebhookTargets,
  finishCandidateCleanup,
  getActiveRepositoryCandidateForMember,
  getPendingGitHubInstallation,
  getRepositoryConnectionForMember,
  saveRepositoryConnection,
  recordGitHubWebhookDelivery,
  reconcileCandidateReview,
  reserveRepositoryCandidate,
  markCandidateMerged,
  markCandidateReviewReady,
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
import { createFloorAgent, createFloorMessage, createFloorQueueItem, getFloorSnapshot } from "@/db/floor";
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

  it("lets the owner end the session, kills the invite, and re-ends idempotently", async () => {
    const owner = await upsertUser(identity("end-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("end-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Ending room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    const result = await endSession(created.session.id, owner.id, env.DB);
    expect(result).toEqual({ endedAt: expect.any(Number) });
    const endedAt = (result as { endedAt: number }).endedAt;

    expect((await getSessionForMember(created.session.id, member.id, env.DB))?.endedAt).toBe(endedAt);
    expect(await getActiveInviteId(created.session.id, owner.id, env.DB)).toBeNull();
    // The old invite is revoked by the same batch, so accepting it fails for everyone.
    const outsider = await upsertUser(identity("end-late", "Late"), env.DB);
    await expect(acceptInvite(created.inviteId, outsider.id, env.DB)).resolves.toBeNull();
    expect(await getInvitePreview(created.inviteId, env.DB)).toBeNull();

    await expect(endSession(created.session.id, owner.id, env.DB)).resolves.toEqual({ endedAt });
  });

  it("lets only owners end sessions and conceals them from outsiders", async () => {
    const owner = await upsertUser(identity("end-auth-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("end-auth-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("end-auth-outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Guarded room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(endSession(created.session.id, member.id, env.DB)).resolves.toBe("forbidden");
    await expect(endSession(created.session.id, outsider.id, env.DB)).resolves.toBe("missing");
    expect((await getSessionForMember(created.session.id, owner.id, env.DB))?.endedAt).toBeNull();
  });

  it("blocks writes on ended sessions while reads and leaving still work", async () => {
    const owner = await upsertUser(identity("end-guard-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("end-guard-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("end-guard-outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Read-only room", objective: "Before" }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    await endSession(created.session.id, owner.id, env.DB);

    await expect(updateSessionObjective(created.session.id, member.id, "After", env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(rotateInvite(created.session.id, owner.id, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(createFloorMessage(created.session.id, member.id, { text: "hello", recipientUserId: null }, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(createFloorQueueItem(created.session.id, member.id, { prompt: "run it", agentId: null }, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    // Outsiders keep getting concealment, not the ended error.
    await expect(updateSessionObjective(created.session.id, outsider.id, "Hidden", env.DB)).resolves.toBeNull();

    expect(await getFloorSnapshot(created.session.id, member.id, env.DB)).not.toBeNull();
    expect((await getSessionForMember(created.session.id, member.id, env.DB))?.objective).toBe("Before");
    await expect(leaveSession(created.session.id, member.id, env.DB)).resolves.toBe("left");
  });

  it("purges only ended sessions past the retention window", async () => {
    const owner = await upsertUser(identity("purge-owner", "Owner"), env.DB);
    const stale = await createSession(owner.id, { title: "Stale ended", objective: null }, env.DB);
    const fresh = await createSession(owner.id, { title: "Fresh ended", objective: null }, env.DB);
    const active = await createSession(owner.id, { title: "Still active", objective: null }, env.DB);
    await endSession(stale.session.id, owner.id, env.DB);
    await endSession(fresh.session.id, owner.id, env.DB);
    await env.DB.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?")
      .bind(Date.now() - ENDED_SESSION_RETENTION_MS - 1_000, stale.session.id)
      .run();

    // meta.changes counts cascade-deleted children too, so assert on outcomes.
    expect(await purgeExpiredSessions(env.DB)).toBeGreaterThanOrEqual(1);

    const remaining = await listSessionsForUser(owner.id, env.DB);
    expect(remaining.map((session) => session.id).sort()).toEqual([active.session.id, fresh.session.id].sort());
    // Cascade sanity: the purged session's graph is gone with it.
    expect(await getSessionForMember(stale.session.id, owner.id, env.DB)).toBeNull();
    expect(await getInvitePreview(stale.inviteId, env.DB)).toBeNull();
  });

  it("lets only owners hard-delete sessions, including ended ones", async () => {
    const owner = await upsertUser(identity("delete-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("delete-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Doomed room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(deleteSession(created.session.id, member.id, env.DB)).resolves.toBe("forbidden");
    await endSession(created.session.id, owner.id, env.DB);
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toBe("deleted");
    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).toBeNull();
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toBe("missing");
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
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Candidate room", "Coordinate candidate work", branch, "main", "a".repeat(40), env.DB)).resolves.toBe(true);
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, crypto.randomUUID(), "Another candidate", "", `${branch}x`, "main", "a".repeat(40), env.DB)).resolves.toBe(false);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    expect(await getActiveRepositoryCandidateForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ name: "Candidate room", description: "Coordinate candidate work", branchName: branch, behindBase: false }));

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
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Preflight room", "", branch, "main", "a".repeat(40), env.DB);
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
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Run room", "Make a focused change", branch, "main", "d".repeat(40), env.DB);
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
    expect(floor?.review).toEqual(expect.objectContaining({ id: candidateId, commitSha: "d".repeat(40), status: "draft" }));
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

    await reconcileCandidateReview(created.session.id, candidateId, {
      number: 7, nodeId: "PR_7", url: "https://github.com/openfloor-test/run/pull/7", state: "open", draft: false,
      merged: false, mergeable: true, mergeableState: "clean", headRef: branch, headSha: integratedSha,
      baseRef: "main", baseSha: "d".repeat(40), mergeCommitSha: null, checksPassing: true,
      files: [{ path: "src/change.ts", additions: 1, deletions: 0, changeKind: "add", patchPreview: "+export const changed = true;" }],
      checks: [{ sourceId: "check:1", name: "CI", detail: "success", state: "passed" }],
    }, env.DB);
    await markCandidateReviewReady(created.session.id, candidateId, owner.id, env.DB);
    const squashSha = "6".repeat(40);
    await markCandidateMerged(created.session.id, candidateId, owner.id, squashSha, env.DB);
    await finishCandidateCleanup(created.session.id, candidateId, [run.id], true, true, env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.activeCandidate).toBeNull();
    expect(floor?.review).toEqual(expect.objectContaining({
      id: candidateId, status: "merged", commitSha: squashSha, githubChecksPassing: true, cleanupStatus: "complete",
      files: [expect.objectContaining({ path: "src/change.ts" })],
      checks: expect.arrayContaining([expect.objectContaining({ name: "CI", state: "passed" })]),
    }));
    expect(floor?.runs.find((item) => item.id === run.id)?.branchDeletedAt).not.toBeNull();
    const nextCandidateId = crypto.randomUUID();
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, nextCandidateId,
      "Next candidate", "Next objective", `openfloor/${created.session.id.slice(0, 8)}/candidate/${nextCandidateId.slice(0, 8)}`, "main", squashSha, env.DB)).resolves.toBe(true);
  });
});

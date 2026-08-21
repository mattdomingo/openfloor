import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  archiveSessionForMember,
  createSession,
  currentMonth,
  deleteSession,
  ENDED_SESSION_RETENTION_MS,
  endSession,
  getActiveInviteId,
  getInvitePreview,
  getSessionForMember,
  getSessionMembers,
  getUsageForUser,
  hourQuotaExhausted,
  leaveSession,
  listSessionsForUser,
  PLAN_LIMITS,
  purgeExpiredSessions,
  revokeInvite,
  rotateInvite,
  SessionEndedError,
  setSessionAutoDispatch,
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
import { createFloorAgent, createFloorMessage, createFloorQueueItem, getFloorSnapshot, setFloorQueueItemPaused } from "@/db/floor";
import {
  beginRunIntegration,
  AgentRunNotReadyError,
  cancelRunIntegration,
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
  it("upserts users by stable provider identity, refreshing email but not the onboarding-owned display name", async () => {
    const first = await upsertUser(identity("owner", "Owner One"), env.DB);
    const updated = await upsertUser({ ...identity("owner", "Owner Two"), email: "new@example.com" }, env.DB);

    expect(updated.id).toBe(first.id);
    expect(updated.providerUserId).toBe("chatgpt-owner");
    expect(updated.displayName).toBe("Owner One");
    expect(updated.email).toBe("new@example.com");
  });

  it("falls back to matching by email when the login method changes the provider id", async () => {
    const first = await upsertUser(identity("switcher", "Switcher"), env.DB);
    const relinked = await upsertUser(
      { ...identity("switcher", "Switcher"), providerUserId: "chatgpt-switcher-alt-method" },
      env.DB,
    );

    expect(relinked.id).toBe(first.id);
    expect(relinked.providerUserId).toBe("chatgpt-switcher-alt-method");
    expect(relinked.email).toBe(first.email);
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
    expect(updated!.objectiveUpdatedAt).toBeGreaterThanOrEqual(created.session.objectiveUpdatedAt);
    await expect(updateSessionObjective(created.session.id, outsider.id, "Hidden", env.DB)).resolves.toBeNull();
  });

  it("only advances objectiveUpdatedAt on an objective save, not on unrelated floor activity", async () => {
    const owner = await upsertUser(identity("objective-isolation-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: "Original" }, env.DB);
    const initial = created.session.objectiveUpdatedAt;
    expect(initial).toBe(created.session.createdAt);

    // Unrelated floor mutations bump updated_at (via bumpFloorRevision) but
    // must never move objectiveUpdatedAt — otherwise the owner nudge
    // (lib/floor-state.ts's countMessagesSinceObjective) could never fire.
    const agentInput = parseAgentInput({ name: "Builder", role: "Engineer", task: "Ship things", ownerUserId: owner.id });
    if (!agentInput) throw new Error("Invalid test agent");
    await createFloorAgent(created.session.id, owner.id, agentInput, env.DB);
    await createFloorMessage(created.session.id, owner.id, { text: "hello team", recipientUserId: null }, env.DB);

    const afterActivity = await getSessionForMember(created.session.id, owner.id, env.DB);
    expect(afterActivity!.objectiveUpdatedAt).toBe(initial);
    expect(afterActivity!.updatedAt).toBeGreaterThanOrEqual(initial);

    const afterSave = await updateSessionObjective(created.session.id, owner.id, "Revised", env.DB);
    expect(afterSave!.objectiveUpdatedAt).toBeGreaterThanOrEqual(initial);
  });

  it("lets the owner end the session, kills the invite, and re-ends idempotently", async () => {
    const owner = await upsertUser(identity("end-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("end-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Ending room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    const result = await endSession(created.session.id, owner.id, "owner", env.DB);
    expect(result).toEqual({ endedAt: expect.any(Number), reason: "owner" });
    const endedAt = (result as { endedAt: number }).endedAt;

    expect((await getSessionForMember(created.session.id, member.id, env.DB))?.endedAt).toBe(endedAt);
    expect(await getActiveInviteId(created.session.id, owner.id, env.DB)).toBeNull();
    // The old invite is revoked by the same batch, so accepting it fails for everyone.
    const outsider = await upsertUser(identity("end-late", "Late"), env.DB);
    await expect(acceptInvite(created.inviteId, outsider.id, env.DB)).resolves.toBeNull();
    expect(await getInvitePreview(created.inviteId, env.DB)).toBeNull();

    await expect(endSession(created.session.id, owner.id, "owner", env.DB)).resolves.toEqual({ endedAt, reason: "owner" });
  });

  it("lets only owners end sessions and conceals them from outsiders", async () => {
    const owner = await upsertUser(identity("end-auth-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("end-auth-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("end-auth-outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Guarded room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(endSession(created.session.id, member.id, "owner", env.DB)).resolves.toBe("forbidden");
    await expect(endSession(created.session.id, outsider.id, "owner", env.DB)).resolves.toBe("missing");
    expect((await getSessionForMember(created.session.id, owner.id, env.DB))?.endedAt).toBeNull();
  });

  it("blocks writes on ended sessions while reads and leaving still work", async () => {
    const owner = await upsertUser(identity("end-guard-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("end-guard-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("end-guard-outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Read-only room", objective: "Before" }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    await endSession(created.session.id, owner.id, "owner", env.DB);

    await expect(updateSessionObjective(created.session.id, member.id, "After", env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(rotateInvite(created.session.id, owner.id, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(createFloorMessage(created.session.id, member.id, { text: "hello", recipientUserId: null }, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(createFloorQueueItem(created.session.id, member.id, { prompt: "run it", agentId: null }, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(createGitHubConnectionState(created.session.id, owner.id, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(saveRepositoryConnection(created.session.id, owner.id, null, "ended-installation", {
      id: "ended-repository", nodeId: "R_ended", owner: "openfloor-test", name: "ended",
      fullName: "openfloor-test/ended", private: true, defaultBranch: "main",
    }, "main", [], env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(createRepositoryPreflight(created.session.id, owner.id, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(createAgentRun(created.session.id, "missing-queue-item", owner.id, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
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
    await endSession(stale.session.id, owner.id, "owner", env.DB);
    await endSession(fresh.session.id, owner.id, "owner", env.DB);
    await env.DB.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?")
      .bind(Date.now() - ENDED_SESSION_RETENTION_MS - 1_000, stale.session.id)
      .run();

    expect(await purgeExpiredSessions(env.DB)).toEqual([stale.session.id]);

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
    await endSession(created.session.id, owner.id, "owner", env.DB);
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toEqual({ deleted: true, candidateBranchAlive: false });
    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).toBeNull();
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toBe("missing");
  });

  it("blocks deletion while a candidate branch is still unmerged, but allows it once merged", async () => {
    const owner = await upsertUser(identity("delete-repository-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Repository audit", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-delete", {
      id: "repository-delete", nodeId: "R_delete", owner: "openfloor-test", name: "audit",
      fullName: "openfloor-test/audit", private: true, defaultBranch: "main",
    }, "main", [], env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Audit room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    // Unmerged: deletion refuses to discard live candidate work.
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toBe("repository_state");
    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).not.toBeNull();

    // Merged, branch not yet deleted: deletion proceeds and flags the surviving branch.
    await markCandidateMerged(created.session.id, candidateId, owner.id, "b".repeat(40), env.DB);
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toEqual({ deleted: true, candidateBranchAlive: true });
    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).toBeNull();
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
    // Cancelled runs park their queue item in a matching terminal status instead of
    // resetting it to "queued", so auto-dispatch does not immediately retry it.
    expect((await getFloorSnapshot(created.session.id, owner.id, env.DB))?.queue[0].status).toBe("cancelled");

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

  it("blocks end/delete while a run is integrating and unblocks once that run is cancelled", async () => {
    const owner = await upsertUser(identity("integrating-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Integration room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-integrating", {
      id: "repository-integrating", nodeId: "R_integrating", owner: "openfloor-test", name: "integrating",
      fullName: "openfloor-test/integrating", private: true, defaultBranch: "main",
    }, "main", ["npm test"], env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Integration room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    const parsed = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement the request", ownerUserId: owner.id });
    if (!parsed) throw new Error("Invalid agent fixture");
    let floor = await createFloorAgent(created.session.id, owner.id, parsed, env.DB);
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Add a real file", agentId: floor!.agents[0].id }, env.DB);
    const run = await createAgentRun(created.session.id, floor!.queue[0].id, owner.id, env.DB);
    await markRunRunning(run.id, "process-1", env.DB);
    await markRunChecking(run.id, "thread-1", "Implemented", env.DB);
    const context = await getRunExecutionContext(run.id, env.DB);
    await markRunCheckRunning(run.id, context!.checks[0].id, env.DB);
    await finishRunCheck(run.id, context!.checks[0].id, { status: "passed", exitCode: 0, durationMs: 5, outputExcerpt: "ok", logKey: `runs/${run.id}/checks/0.log` }, env.DB);
    await finishAgentRun(run.id, "ready", "Ready locally", env.DB);
    const publishedSha = "e".repeat(40);
    await markRunPublishing(run.id, { bundleKey: `runs/${run.id}/result.bundle`, bundleSizeBytes: 100, localCommitSha: "f".repeat(40) }, env.DB);
    await finishRunPublished(run.id, publishedSha, publishedSha, env.DB);
    await beginRunIntegration(run.id, env.DB);

    // A run holding the candidate's integration lock blocks both end and delete.
    await expect(endSession(created.session.id, owner.id, "owner", env.DB)).resolves.toEqual({ blocked: "integration_in_progress", runId: run.id });
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toEqual({ blocked: "integration_in_progress", runId: run.id });

    // requestAgentRunCancellation now accepts 'integrating', and cancelRunIntegration
    // releases the candidate's lock the way the workflow does once it notices.
    await expect(requestAgentRunCancellation(created.session.id, run.id, owner.id, env.DB)).resolves.toBe(true);
    const cancelled = await cancelRunIntegration(run.id, env.DB);
    expect(cancelled).toEqual(expect.objectContaining({ sessionId: created.session.id }));
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.runs.find((item) => item.id === run.id)?.status).toBe("cancelled");
    expect(floor?.queue[0].status).toBe("cancelled");

    // The candidate's lock is clear now, so ending proceeds — deleting still
    // refuses because the candidate itself remains live and unmerged.
    await expect(endSession(created.session.id, owner.id, "owner", env.DB)).resolves.toEqual({ endedAt: expect.any(Number), reason: "owner" });
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toBe("repository_state");
  });
});

describe("plan limits", () => {
  it("a newly created user defaults to the free plan, inactive", async () => {
    const user = await upsertUser(identity("plan-default-user", "Default"), env.DB);
    // The stored columns default to plan='pro'/'inactive' — free-tier limits
    // come from effectivePlan(), not from a literal 'free' in the plan
    // column (see the schema comment in db/schema.ts for why).
    expect(user.plan).toBe("pro");
    expect(user.planStatus).toBe("inactive");
    const usage = await getUsageForUser(user.id, env.DB);
    expect(usage.effectivePlan).toBe("free");
    expect(usage.limitHours).toBe(PLAN_LIMITS.free.hours);
    expect(usage.limitSeats).toBe(PLAN_LIMITS.free.seats);
  });

  it("stops invite accepts at the owner's effective plan's seat cap, per plan and status", async () => {
    const owner = await upsertUser(identity("cap-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Full", objective: null }, env.DB);

    // Default (inactive → free, 3 seats: owner + 2).
    const members = [];
    for (let index = 0; index < 2; index += 1) {
      const member = await upsertUser(identity(`cap-member-free-${index}`, `Free ${index}`), env.DB);
      members.push(member);
      await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);
    }
    const overFree = await upsertUser(identity("cap-member-over-free", "OverFree"), env.DB);
    await expect(acceptInvite(created.inviteId, overFree.id, env.DB)).resolves.toBe("full");
    // Re-accepting as an existing member stays idempotent past the cap.
    await expect(acceptInvite(created.inviteId, members[0].id, env.DB)).resolves.toBe(created.session.id);
    expect(await getSessionMembers(created.session.id, owner.id, env.DB)).toHaveLength(3);

    // Activate Pro (5 seats): owner + 2 free-tier + overFree = 4 already;
    // one more fits exactly at the cap.
    await env.DB.prepare("UPDATE users SET plan = 'pro', plan_status = 'active' WHERE id = ?").bind(owner.id).run();
    await expect(acceptInvite(created.inviteId, overFree.id, env.DB)).resolves.toBe(created.session.id);
    const fifthPro = await upsertUser(identity("cap-member-pro", "Pro"), env.DB);
    members.push(fifthPro);
    await expect(acceptInvite(created.inviteId, fifthPro.id, env.DB)).resolves.toBe(created.session.id);
    expect(await getSessionMembers(created.session.id, owner.id, env.DB)).toHaveLength(5);
    const overPro = await upsertUser(identity("cap-member-over-pro", "OverPro"), env.DB);
    await expect(acceptInvite(created.inviteId, overPro.id, env.DB)).resolves.toBe("full");

    // Activate Max (10 seats): the sixth fits.
    await env.DB.prepare("UPDATE users SET plan = 'max' WHERE id = ?").bind(owner.id).run();
    await expect(acceptInvite(created.inviteId, overPro.id, env.DB)).resolves.toBe(created.session.id);
    expect(await getSessionMembers(created.session.id, owner.id, env.DB)).toHaveLength(6);

    // Cancel: falls straight back to the free 3-seat cap, already exceeded
    // at 6 members — a brand new member is refused even though an existing
    // one can still idempotently "re-accept".
    await env.DB.prepare("UPDATE users SET plan_status = 'canceled' WHERE id = ?").bind(owner.id).run();
    await expect(acceptInvite(created.inviteId, members[0].id, env.DB)).resolves.toBe(created.session.id);
    const afterCancel = await upsertUser(identity("cap-member-after-cancel", "AfterCancel"), env.DB);
    await expect(acceptInvite(created.inviteId, afterCancel.id, env.DB)).resolves.toBe("full");
  });

  it("enterprise has no seat cap", async () => {
    const owner = await upsertUser(identity("cap-owner-enterprise", "Owner"), env.DB);
    await env.DB.prepare("UPDATE users SET plan = 'enterprise', plan_status = 'active' WHERE id = ?").bind(owner.id).run();
    const created = await createSession(owner.id, { title: "Enterprise", objective: null }, env.DB);
    for (let index = 0; index < 12; index += 1) {
      const member = await upsertUser(identity(`cap-member-enterprise-${index}`, `Member ${index}`), env.DB);
      await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);
    }
    expect(await getSessionMembers(created.session.id, owner.id, env.DB)).toHaveLength(13);
  });

  it("reports hour quota exhaustion from usage_months, gated by plan_status not plan alone", async () => {
    const user = await upsertUser(identity("quota-user", "Quota"), env.DB);
    // Default (inactive → free's 2h cap).
    await expect(hourQuotaExhausted(user.id, env.DB)).resolves.toBe(false);
    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(user.id, currentMonth(), 2 * 3600)
      .run();
    await expect(hourQuotaExhausted(user.id, env.DB)).resolves.toBe(true);

    // Setting plan alone (still inactive) does not lift the gate — a
    // purchased tier only grants its limits while active.
    await env.DB.prepare("UPDATE users SET plan = 'max' WHERE id = ?").bind(user.id).run();
    await expect(hourQuotaExhausted(user.id, env.DB)).resolves.toBe(true);

    // Activating status lifts it: the same 2h sits well under Max's 100h.
    await env.DB.prepare("UPDATE users SET plan_status = 'active' WHERE id = ?").bind(user.id).run();
    await expect(hourQuotaExhausted(user.id, env.DB)).resolves.toBe(false);

    // Cancelling (or past_due) drops back to the free 2h cap, already spent.
    await env.DB.prepare("UPDATE users SET plan_status = 'canceled' WHERE id = ?").bind(user.id).run();
    await expect(hourQuotaExhausted(user.id, env.DB)).resolves.toBe(true);
    await env.DB.prepare("UPDATE users SET plan_status = 'past_due' WHERE id = ?").bind(user.id).run();
    await expect(hourQuotaExhausted(user.id, env.DB)).resolves.toBe(true);
  });

  it("upsertUser does not reset plan or plan_status on re-login", async () => {
    const user = await upsertUser(identity("plan-persist-user", "Persist"), env.DB);
    await env.DB.prepare("UPDATE users SET plan = 'max', plan_status = 'active' WHERE id = ?").bind(user.id).run();
    const relogged = await upsertUser(identity("plan-persist-user", "Persist"), env.DB);
    expect(relogged.plan).toBe("max");
    expect(relogged.planStatus).toBe("active");
  });

  it("the wind-down set (end, leave, revoke, auto-dispatch off, pause, archive, delete) still works at quota", async () => {
    // The quota gate only sits in front of the operations that spend money —
    // startQueueItemRun and the repository preflight/sync routes — never in
    // front of getActiveMembershipRole itself. Everything here must keep
    // working for an owner who is out of hours, so they can always wind
    // down and never get stuck.
    const owner = await upsertUser(identity("winddown-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("winddown-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Wind down", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(owner.id, currentMonth(), 2 * 3600)
      .run();
    await expect(hourQuotaExhausted(owner.id, env.DB)).resolves.toBe(true);

    await expect(revokeInvite(created.session.id, owner.id, env.DB)).resolves.toBe(true);
    await expect(setSessionAutoDispatch(created.session.id, owner.id, false, env.DB)).resolves.toBe(true);

    const floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Pause me", agentId: null }, env.DB);
    const queueItemId = floor!.queue[0].id;
    await expect(setFloorQueueItemPaused(created.session.id, owner.id, queueItemId, true, env.DB)).resolves.not.toBeNull();

    await expect(archiveSessionForMember(created.session.id, owner.id, env.DB)).resolves.toBe("archived");
    await expect(leaveSession(created.session.id, member.id, env.DB)).resolves.toBe("left");
    await expect(endSession(created.session.id, owner.id, "owner", env.DB)).resolves.toEqual(
      expect.objectContaining({ reason: "owner" }),
    );

    // Delete needs its own session (endSession above already consumed this
    // one's "live" state, and delete works on either).
    const secondCreated = await createSession(owner.id, { title: "Wind down 2", objective: null }, env.DB);
    await expect(deleteSession(secondCreated.session.id, owner.id, env.DB)).resolves.toEqual(
      expect.objectContaining({ deleted: true }),
    );
  });
});

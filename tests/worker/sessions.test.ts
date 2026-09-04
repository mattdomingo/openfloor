import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  archiveSessionForMember,
  createSession,
  currentMonth,
  deleteAccount,
  deleteSession,
  ENDED_SESSION_PURGE_BATCH_SIZE,
  ENDED_SESSION_RETENTION_MS,
  endMergedSession,
  endSession,
  getActiveInviteId,
  getInvitePreview,
  getMembershipRole,
  getRemovedSessionMembers,
  getSessionForMember,
  getSessionMembers,
  getUsageForUser,
  hourQuotaExhausted,
  leaveSession,
  listSessionsForUser,
  PLAN_LIMITS,
  purgeExpiredSessions,
  removeMember,
  restoreMember,
  revokeInvite,
  rotateInvite,
  SessionEndedError,
  setSessionAutoDispatch,
  setSessionLocked,
  updateProfile,
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
  releaseGitHubWebhookDelivery,
  reconcileCandidateReview,
  getCandidateReviewSyncContext,
  reserveRepositoryCandidate,
  markCandidateAbandoned,
  markCandidateMerged,
  markCandidateReviewDraft,
  markCandidateReviewReady,
  setCandidateMergeLocked,
  updateRepositoryPushState,
} from "@/db/repositories";
import { abandonSessionCandidate } from "@/lib/candidate-abandon";
import { createFloorAgent, createFloorMessage, createFloorQueueItem, getFloorSnapshot, setFloorQueueItemPaused, updateFloorAssignment } from "@/db/floor";
import {
  beginRunIntegration,
  AgentRunNotReadyError,
  cancelRunIntegration,
  createAgentRun,
  finishAgentReply,
  finishAgentRun,
  finishRunPublished,
  finishRunIntegrated,
  getAgentRun,
  getRunArtifactKeysForMember,
  getRunExecutionContext,
  markRunChecking,
  markRunRunning,
  markRunDiscarded,
  markRunPublishing,
  markRunIntegrationConflicted,
  prepareConflictedRunRetry,
  recordRunArtifact,
  recordRunPublicationFailure,
  replaceRunFiles,
  requestAgentRunCancellation,
  setRunProviderThreadId,
} from "@/db/runs";
import { parseAgentInput } from "@/lib/validation";
import {
  beginAgentRunRollback,
  beginAgentRunRollbackGroup,
  createAgentRunRollback,
  createAgentRunRollbackGroup,
  failAgentRunRollback,
  failAgentRunRollbackGroup,
  finishAgentRunRollback,
  finishAgentRunRollbackGroup,
} from "@/db/rollbacks";
import { getSessionContext } from "@/db/session-context";
import {
  consumeGitHubAccountConnectionState,
  createGitHubAccountConnectionState,
  listUserGitHubInstallations,
  removeUserGitHubInstallation,
} from "@/db/github-installations";
import { getReviewContribution, listReviewContributions, resolveReviewRollbackImpact } from "@/db/review-contributions";

function identity(id: string, name: string) {
  return { providerUserId: `chatgpt-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

describe("D1 session persistence", () => {
  it("migration 0032 backfills deduplicated active account GitHub installations", async () => {
    const owner = await upsertUser(identity("github-backfill-owner", "Backfill Owner"), env.DB);
    const other = await upsertUser(identity("github-backfill-other", "Other Owner"), env.DB);
    const first = await createSession(owner.id, { title: "First backfill room", objective: null }, env.DB);
    const second = await createSession(owner.id, { title: "Second backfill room", objective: null }, env.DB);
    const inaccessible = await createSession(owner.id, { title: "Inaccessible room", objective: null }, env.DB);
    const otherRoom = await createSession(other.id, { title: "Other backfill room", objective: null }, env.DB);
    const repository = {
      id: "repository-backfill", nodeId: "R_backfill", owner: "acme", name: "widgets",
      fullName: "acme/widgets", private: true, defaultBranch: "main",
    };
    await saveRepositoryConnection(first.session.id, owner.id, null, "installation-shared", repository, "main", env.DB);
    await saveRepositoryConnection(second.session.id, owner.id, null, "installation-shared", { ...repository, id: "repository-backfill-two", nodeId: "R_backfill_two", name: "tools", fullName: "acme/tools" }, "main", env.DB);
    await saveRepositoryConnection(inaccessible.session.id, owner.id, null, "installation-inaccessible", { ...repository, id: "repository-inaccessible", nodeId: "R_inaccessible" }, "main", env.DB);
    await saveRepositoryConnection(otherRoom.session.id, other.id, null, "installation-shared", repository, "main", env.DB);
    await env.DB.prepare("UPDATE repository_connections SET status = 'ready' WHERE session_id = ?").bind(second.session.id).run();
    await env.DB.prepare("UPDATE repository_connections SET status = 'inaccessible' WHERE session_id = ?").bind(inaccessible.session.id).run();

    await env.DB.prepare("DROP TABLE github_account_connection_states").run();
    await env.DB.prepare("DROP TABLE user_github_installations").run();
    const queries = JSON.parse(env.ACCOUNT_GITHUB_MIGRATION_QUERIES) as string[];
    await env.DB.batch(queries.map((query) => env.DB.prepare(query)));
    // The 0032 replay rebuilt the table at its historical shape; restore the
    // 0038 repo_scope column so later tests in this file see today's schema.
    await env.DB.prepare("ALTER TABLE user_github_installations ADD `repo_scope` text").run();

    // Legacy rows without verified repository scope remain stored for audit,
    // but no longer appear connected or authorize onboarding.
    expect(await listUserGitHubInstallations(owner.id, env.DB)).toEqual([]);
    expect(await listUserGitHubInstallations(other.id, env.DB)).toEqual([]);
    const backfilled = await env.DB.prepare(
      "SELECT user_id AS userId, installation_id AS installationId FROM user_github_installations ORDER BY user_id",
    ).all<{ userId: string; installationId: string }>();
    expect(backfilled.results).toEqual([
      { userId: other.id, installationId: "installation-shared" },
      { userId: owner.id, installationId: "installation-shared" },
    ].sort((a, b) => a.userId.localeCompare(b.userId)));
  });

  it("binds single-use account GitHub state to user and removal preserves existing session access", async () => {
    const owner = await upsertUser(identity("account-github-owner", "GitHub Owner"), env.DB);
    const outsider = await upsertUser(identity("account-github-outsider", "GitHub Outsider"), env.DB);
    const expiredStateId = await createGitHubAccountConnectionState(owner.id, "onboarding", "/home", env.DB);
    await env.DB.prepare("UPDATE github_account_connection_states SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expiredStateId).run();
    await expect(consumeGitHubAccountConnectionState(
      expiredStateId, owner.id, "installation-expired", { login: "expired", type: "Organization" }, [], env.DB,
    )).resolves.toBeNull();
    const stateId = await createGitHubAccountConnectionState(owner.id, "onboarding", "/home", env.DB);
    await expect(consumeGitHubAccountConnectionState(
      stateId, outsider.id, "installation-account", { login: "openfloor", type: "Organization" }, [], env.DB,
    )).resolves.toBeNull();
    await expect(consumeGitHubAccountConnectionState(
      stateId, owner.id, "installation-account", { login: "openfloor", type: "Organization" }, [], env.DB,
    )).resolves.toEqual({ purpose: "onboarding", returnTo: "/home" });
    await expect(consumeGitHubAccountConnectionState(
      stateId, owner.id, "installation-account", { login: "openfloor", type: "Organization" }, [], env.DB,
    )).resolves.toBeNull();
    await expect(listUserGitHubInstallations(owner.id, env.DB)).resolves.toEqual([]);
    const verifiedStateId = await createGitHubAccountConnectionState(owner.id, "onboarding", "/home", env.DB);
    await expect(consumeGitHubAccountConnectionState(
      verifiedStateId, owner.id, "installation-account", { login: "openfloor", type: "Organization" }, ["repository-account"], env.DB,
    )).resolves.toEqual({ purpose: "onboarding", returnTo: "/home" });
    const [installation] = await listUserGitHubInstallations(owner.id, env.DB);
    expect(installation).toEqual(expect.objectContaining({ accountLogin: "openfloor", status: "active" }));

    const created = await createSession(owner.id, { title: "Preserved repository", objective: null }, env.DB);
    await saveRepositoryConnection(created.session.id, owner.id, null, "installation-account", {
      id: "repository-account", nodeId: "R_account", owner: "openfloor", name: "repo",
      fullName: "openfloor/repo", private: true, defaultBranch: "main",
    }, "main", env.DB);
    await expect(removeUserGitHubInstallation(owner.id, installation.id, env.DB)).resolves.toBe(true);
    await expect(listUserGitHubInstallations(owner.id, env.DB)).resolves.toEqual([]);
    await expect(getRepositoryConnectionForMember(created.session.id, owner.id, env.DB)).resolves.toEqual(
      expect.objectContaining({ installationId: "installation-account", status: "connected" }),
    );
  });

  it("backfills existing sessions off while preserving and safely deactivating legacy Concierge rows", async () => {
    const owner = await upsertUser(identity("auto-migration-owner", "Migration Owner"), env.DB);
    const existing = await createSession(owner.id, { title: "Existing auto room", objective: null }, env.DB);
    expect(existing.session.autoProvisionAgents).toBe(true);
    const now = Date.now();
    const idleConciergeId = crypto.randomUUID();
    const busyConciergeId = crypto.randomUUID();
    for (const [id, name, nameKey] of [[idleConciergeId, "Concierge", "concierge"], [busyConciergeId, "Concierge 2", "concierge 2"]]) {
      await env.DB.prepare(
        `INSERT INTO floor_agents (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, provider, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Session answers', 'Answer questions', 'created', 'openai', 'answer', ?, ?)`,
      ).bind(id, existing.session.id, owner.id, owner.id, name, nameKey, now, now).run();
    }
    const idleQueueId = crypto.randomUUID();
    const busyQueueId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'completed', ?, ?)",
      ).bind(idleQueueId, existing.session.id, idleConciergeId, now, now),
      env.DB.prepare(
        "INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, created_at, updated_at) VALUES (?, ?, ?, 2, 'running', ?, ?)",
      ).bind(busyQueueId, existing.session.id, busyConciergeId, now, now),
    ]);

    const queries = JSON.parse(env.AUTO_AGENT_DATA_MIGRATION_QUERIES) as string[];
    await env.DB.batch(queries.map((query) => env.DB.prepare(query)));
    expect((await getSessionForMember(existing.session.id, owner.id, env.DB))?.autoProvisionAgents).toBe(false);
    const agents = await env.DB.prepare(
      "SELECT id, deprovisioned_at AS deprovisionedAt FROM floor_agents WHERE session_id = ? ORDER BY name",
    ).bind(existing.session.id).all<{ id: string; deprovisionedAt: number | null }>();
    expect(agents.results.find((agent) => agent.id === idleConciergeId)?.deprovisionedAt).not.toBeNull();
    expect(agents.results.find((agent) => agent.id === busyConciergeId)?.deprovisionedAt).toBeNull();
    expect((await env.DB.prepare("SELECT agent_id AS agentId FROM floor_queue_items WHERE id = ?").bind(idleQueueId).first<{ agentId: string }>())?.agentId).toBe(idleConciergeId);

    const fresh = await createSession(owner.id, { title: "Fresh auto room", objective: null }, env.DB);
    expect(fresh.session.autoProvisionAgents).toBe(true);
  });

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

  it("round-trips between two login methods for the same email without ever creating a third account", async () => {
    const base = identity("ping-pong", "Ping Pong");
    const google = { ...base, providerUserId: "chatgpt-ping-pong-google" };
    const otp = { ...base, providerUserId: "chatgpt-ping-pong-otp" };

    const first = await upsertUser(google, env.DB);
    const second = await upsertUser(otp, env.DB);
    const third = await upsertUser(google, env.DB);
    const fourth = await upsertUser(otp, env.DB);

    expect(new Set([first.id, second.id, third.id, fourth.id]).size).toBe(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").bind(base.email).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("resolves a concurrent first login for the same new email to a single account", async () => {
    const first = identity("concurrent-new", "Concurrent");
    const second = { ...first, providerUserId: "chatgpt-concurrent-new-other-method" };

    const [a, b] = await Promise.all([upsertUser(first, env.DB), upsertUser(second, env.DB)]);

    expect(a.id).toBe(b.id);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").bind(first.email).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("updateProfile sets, keeps, and clears the avatar independently of names, and recomputes display_name", async () => {
    const user = await upsertUser(identity("profile-edit", "Original Name"), env.DB);
    await expect(updateProfile(user.id, { firstName: "Matt", lastName: "Domingo", githubHandle: "octocat", avatarKey: "users/a/avatar" }, env.DB))
      .resolves.toMatchObject({ firstName: "Matt", lastName: "Domingo", githubHandle: "octocat", displayName: "Matt D.", avatarKey: "users/a/avatar" });

    // avatarKey omitted (undefined): keeps the existing key.
    const kept = await updateProfile(user.id, { firstName: "Matt", lastName: "D.", githubHandle: "octocat", avatarKey: undefined }, env.DB);
    expect(kept.avatarKey).toBe("users/a/avatar");
    expect(kept.displayName).toBe("Matt D.");

    // avatarKey explicitly null: clears it — completeOnboarding's COALESCE
    // can only ever add a picture, never remove one; this is the fix.
    const cleared = await updateProfile(user.id, { firstName: "Matt", lastName: "Domingo", githubHandle: null, avatarKey: null }, env.DB);
    expect(cleared.avatarKey).toBeNull();
    expect(cleared.githubHandle).toBeNull();

    // Never touches onboarded_at.
    expect(cleared.onboardedAt).toBeNull();
  });

  it("deleteAccount deletes owned sessions, drops residual memberships elsewhere, and scrubs the identity, without touching usage_months", async () => {
    const deleted = await upsertUser(identity("delacct-self", "Self"), env.DB);
    const otherOwner = await upsertUser(identity("delacct-other", "Other Owner"), env.DB);

    const owned = await createSession(deleted.id, { title: "My room", objective: null }, env.DB);
    const joined = await createSession(otherOwner.id, { title: "Their room", objective: null }, env.DB);
    await acceptInvite(joined.inviteId, deleted.id, env.DB);
    await updateFloorAssignment(joined.session.id, otherOwner.id, deleted.id, { task: "Review" }, env.DB);
    await createFloorMessage(joined.session.id, deleted.id, { text: "hello from the deleted user", recipientUserId: null }, env.DB);

    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(deleted.id, currentMonth(), 120)
      .run();

    await expect(deleteAccount(deleted.id, env.DB)).resolves.toEqual({ deleted: true });
    expect((await env.DB.prepare("SELECT 1 AS present FROM storage_cleanup_prefixes WHERE bucket = 'user_avatars' AND prefix = ?").bind(`users/${deleted.id}/avatar`).first())?.present).toBe(1);

    // Owned session and its graph are gone.
    expect(await getSessionForMember(owned.session.id, otherOwner.id, env.DB)).toBeNull();

    // Membership and assignment in the other owner's session are gone, but
    // the message the deleted user authored survives, attributed to the
    // scrubbed tombstone display name.
    const remainingMembers = await getSessionMembers(joined.session.id, otherOwner.id, env.DB);
    expect(remainingMembers?.map((member) => member.id)).toEqual([otherOwner.id]);
    const assignmentRow = await env.DB.prepare("SELECT 1 AS present FROM floor_assignments WHERE session_id = ? AND user_id = ?")
      .bind(joined.session.id, deleted.id).first();
    expect(assignmentRow).toBeNull();
    const messageRow = await env.DB.prepare(
      "SELECT fm.text AS text, u.display_name AS authorName FROM floor_messages fm JOIN users u ON u.id = fm.author_user_id WHERE fm.session_id = ?",
    ).bind(joined.session.id).first<{ text: string; authorName: string }>();
    expect(messageRow).toEqual({ text: "hello from the deleted user", authorName: "Deleted user" });

    // The usage ledger survives account deletion by design.
    const usageRow = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
      .bind(deleted.id, currentMonth()).first<{ seconds: number }>();
    expect(usageRow).toEqual({ seconds: 120 });

    // The departing email's hash survives on the tombstone so a future
    // resignup with the same address can be recognized (see the
    // free-allowance test below) — never the plaintext email itself.
    const tombstone = await env.DB.prepare("SELECT prior_email_hash AS hash, email AS email FROM users WHERE id = ?")
      .bind(deleted.id).first<{ hash: string | null; email: string }>();
    expect(tombstone?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tombstone?.email).not.toContain("delacct-self@example.com");

    // The same Access identity signing in again creates a brand-new row,
    // not a resurrection of the tombstoned one.
    const resurrected = await upsertUser(identity("delacct-self", "Self Again"), env.DB);
    expect(resurrected.id).not.toBe(deleted.id);
    expect(resurrected.displayName).toBe("Self Again");
    expect(resurrected.onboardedAt).toBeNull();
  });

  it("deleteAccount no longer blocks on repository state — a live, unabandoned candidate cascades away with its session", async () => {
    const owner = await upsertUser(identity("delacct-repostate", "Repo State Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Repo state room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-delacct-repostate", {
      id: "repository-delacct-repostate", nodeId: "R_delacct_repostate", owner: "openfloor-test", name: "delacct-repostate",
      fullName: "openfloor-test/delacct-repostate", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Repo state room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    await expect(deleteAccount(owner.id, env.DB)).resolves.toEqual({ deleted: true });

    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).toBeNull();
    const candidateRow = await env.DB.prepare("SELECT 1 AS present FROM repository_candidates WHERE id = ?").bind(candidateId).first();
    expect(candidateRow).toBeNull();
  });

  it("deleteAccount still refuses and writes nothing while an owned session's candidate is mid-integration", async () => {
    const owner = await upsertUser(identity("delacct-blocked", "Blocked Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Blocked room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-delacct", {
      id: "repository-delacct", nodeId: "R_delacct", owner: "openfloor-test", name: "delacct",
      fullName: "openfloor-test/delacct", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Blocked room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    await env.DB.prepare("UPDATE repository_candidates SET integration_run_id = ? WHERE id = ?").bind(crypto.randomUUID(), candidateId).run();

    const result = await deleteAccount(owner.id, env.DB);
    expect(result).toMatchObject({ blocked: "sessions", sessions: [{ id: created.session.id, title: "Blocked room", reason: "integration_in_progress" }] });

    // Nothing was written: the session and the owner's account both remain.
    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).not.toBeNull();
    const stillThere = await env.DB.prepare("SELECT deleted_at AS deletedAt FROM users WHERE id = ?").bind(owner.id).first<{ deletedAt: number | null }>();
    expect(stillThere?.deletedAt).toBeNull();
  });

  it("a deleted account's email loses its free plan hour allowance on resignup, until it pays", async () => {
    const first = await upsertUser(identity("free-allowance-reuse", "First"), env.DB);
    expect((await getUsageForUser(first.id, env.DB)).limitHours).toBe(2);

    await expect(deleteAccount(first.id, env.DB)).resolves.toEqual({ deleted: true });

    const second = await upsertUser(identity("free-allowance-reuse", "Second"), env.DB);
    expect(second.id).not.toBe(first.id);
    expect((await getUsageForUser(second.id, env.DB)).limitHours).toBe(0);

    // A paid, active plan is unaffected by the flag.
    await env.DB.prepare("UPDATE users SET plan = 'pro', plan_status = 'active' WHERE id = ?").bind(second.id).run();
    expect((await getUsageForUser(second.id, env.DB)).limitHours).toBe(30);

    // A different address was never touched.
    const unrelated = await upsertUser(identity("free-allowance-untouched", "Unrelated"), env.DB);
    expect((await getUsageForUser(unrelated.id, env.DB)).limitHours).toBe(2);

    // The @opnflr.com unlimited-testing override still wins regardless.
    const internal = await upsertUser({ providerUserId: "chatgpt-internal", email: "someone@opnflr.com", displayName: "Internal", fullName: "Internal" }, env.DB);
    await expect(deleteAccount(internal.id, env.DB)).resolves.toEqual({ deleted: true });
    const internalAgain = await upsertUser({ providerUserId: "chatgpt-internal", email: "someone@opnflr.com", displayName: "Internal", fullName: "Internal" }, env.DB);
    expect((await getUsageForUser(internalAgain.id, env.DB)).limitHours).toBe(Infinity);
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

  it("defaults a new session to auto-dispatch on", async () => {
    // Otherwise a prompt submitted with target "Auto" has no path to a Run
    // button at all until an owner finds the queue's automation menu.
    const owner = await upsertUser(identity("autodispatch-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Auto room", objective: null }, env.DB);
    const floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.autoDispatch).toBe(true);
  });

  it("migration 0027's one-time backfill turns auto-dispatch on for live sessions only", async () => {
    // Simulates a session created before auto_dispatch defaulted to true, plus
    // an ended one that must NOT be turned on retroactively (AGENTS.md: an
    // ended session is read-only). Mirrors drizzle/0027's UPDATE exactly.
    const owner = await upsertUser(identity("backfill-owner", "Owner"), env.DB);
    const live = await createSession(owner.id, { title: "Pre-existing live room", objective: null }, env.DB);
    const ended = await createSession(owner.id, { title: "Pre-existing ended room", objective: null }, env.DB);
    await env.DB.prepare("UPDATE sessions SET auto_dispatch = 0 WHERE id IN (?, ?)")
      .bind(live.session.id, ended.session.id).run();
    await endSession(ended.session.id, owner.id, "owner", env.DB);

    await env.DB.prepare("UPDATE sessions SET auto_dispatch = 1 WHERE ended_at IS NULL").run();

    const liveRow = await env.DB.prepare("SELECT auto_dispatch AS autoDispatch FROM sessions WHERE id = ?")
      .bind(live.session.id).first<{ autoDispatch: number }>();
    const endedRow = await env.DB.prepare("SELECT auto_dispatch AS autoDispatch FROM sessions WHERE id = ?")
      .bind(ended.session.id).first<{ autoDispatch: number }>();
    expect(liveRow?.autoDispatch).toBe(1);
    expect(endedRow?.autoDispatch).toBe(0);
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

  it("reassigns a leaving member's agents to the owner instead of stranding them", async () => {
    const owner = await upsertUser(identity("leave-agent-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("leave-agent-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    const agentInput = parseAgentInput({ name: "Scout", role: "Researcher", task: "Look into things", ownerUserId: member.id });
    if (!agentInput) throw new Error("Invalid test agent");
    await createFloorAgent(created.session.id, member.id, agentInput, env.DB);

    await leaveSession(created.session.id, member.id, env.DB);

    const floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor!.agents[0].ownerUserId).toBe(owner.id);
  });

  it("lets the owner remove a member: frees their seat, blocks re-accepting the link, and reassigns their agents", async () => {
    const owner = await upsertUser(identity("remove-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("remove-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    const agentInput = parseAgentInput({ name: "Scout", role: "Researcher", task: "Look into things", ownerUserId: member.id });
    if (!agentInput) throw new Error("Invalid test agent");
    await createFloorAgent(created.session.id, member.id, agentInput, env.DB);

    const result = await removeMember(created.session.id, owner.id, member.id, env.DB);
    expect(result).toEqual({ removedAt: expect.any(Number), revision: expect.any(Number) });

    // The removed member reads as a non-member everywhere the write and read
    // guards are checked, and their floor read is refused.
    expect(await getMembershipRole(created.session.id, member.id, env.DB)).toBeNull();
    expect(await getFloorSnapshot(created.session.id, member.id, env.DB)).toBeNull();
    expect(await getSessionMembers(created.session.id, owner.id, env.DB)).toHaveLength(1);

    // Their agent transferred to the owner rather than being stranded on a
    // non-member (the same invariant leaveSession now also preserves).
    const floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor!.agents[0].ownerUserId).toBe(owner.id);

    // Re-accepting the still-valid invite is refused, not silently successful
    // — the seat stays freed rather than being reclaimed by the same person.
    await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe("removed");
    expect(await getSessionMembers(created.session.id, owner.id, env.DB)).toHaveLength(1);

    // The audit trail is visible to the owner.
    expect(await getRemovedSessionMembers(created.session.id, owner.id, env.DB)).toEqual([
      expect.objectContaining({ id: member.id, removedAt: expect.any(Number) }),
    ]);
  });

  it("confines removal to the owner, and refuses removing self or another owner", async () => {
    const owner = await upsertUser(identity("remove-guard-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("remove-guard-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("remove-guard-outsider", "Outsider"), env.DB);
    const nonMember = await upsertUser(identity("remove-guard-nonmember", "NonMember"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(removeMember(created.session.id, member.id, owner.id, env.DB)).resolves.toBe("forbidden");
    await expect(removeMember(created.session.id, outsider.id, member.id, env.DB)).resolves.toBe("missing");
    await expect(removeMember(created.session.id, owner.id, owner.id, env.DB)).resolves.toBe("self");
    await expect(removeMember(created.session.id, owner.id, nonMember.id, env.DB)).resolves.toBe("missing");

    // owner_target: the schema permits a second 'owner' row even though the
    // product never creates one — refuse it defensively too.
    await env.DB.prepare("INSERT INTO session_members (session_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .bind(created.session.id, nonMember.id, Date.now()).run();
    await expect(removeMember(created.session.id, owner.id, nonMember.id, env.DB)).resolves.toBe("owner_target");
  });

  it("refuses removal and locking on an ended session", async () => {
    const owner = await upsertUser(identity("remove-ended-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("remove-ended-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    await endSession(created.session.id, owner.id, "owner", env.DB);

    await expect(removeMember(created.session.id, owner.id, member.id, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(setSessionLocked(created.session.id, owner.id, true, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
  });

  it("lets the owner restore a removed member when there's room, but refuses at the seat cap", async () => {
    const owner = await upsertUser(identity("restore-owner", "Owner"), env.DB);
    const memberA = await upsertUser(identity("restore-member-a", "MemberA"), env.DB);
    const memberB = await upsertUser(identity("restore-member-b", "MemberB"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, memberA.id, env.DB);

    // Room to spare (owner + memberA = 2, free-tier cap is 3): restore succeeds.
    await removeMember(created.session.id, owner.id, memberA.id, env.DB);
    await expect(restoreMember(created.session.id, owner.id, memberA.id, env.DB)).resolves.toEqual({ restoredAt: expect.any(Number) });
    expect(await getSessionMembers(created.session.id, owner.id, env.DB)).toHaveLength(2);
    expect(await getRemovedSessionMembers(created.session.id, owner.id, env.DB)).toEqual([]);

    // Fill to the cap (owner + memberA + memberB), then remove memberA again
    // and backfill their freed seat with a third joiner before restoring —
    // restoring now would exceed the cap and must be refused.
    await acceptInvite(created.inviteId, memberB.id, env.DB);
    await removeMember(created.session.id, owner.id, memberA.id, env.DB);
    const memberC = await upsertUser(identity("restore-member-c", "MemberC"), env.DB);
    await acceptInvite(created.inviteId, memberC.id, env.DB);
    expect(await getSessionMembers(created.session.id, owner.id, env.DB)).toHaveLength(3);

    await expect(restoreMember(created.session.id, owner.id, memberA.id, env.DB)).resolves.toBe("full");
    // Still removed, and the invite link remains blocked for them too.
    await expect(acceptInvite(created.inviteId, memberA.id, env.DB)).resolves.toBe("removed");
  });

  it("lets the owner lock and unlock a session: new joins refused, existing members and re-accepts unaffected", async () => {
    const owner = await upsertUser(identity("lock-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("lock-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(setSessionLocked(created.session.id, member.id, true, env.DB)).resolves.toBe(false);
    await expect(setSessionLocked(created.session.id, owner.id, true, env.DB)).resolves.toEqual({ lockedAt: expect.any(Number) });

    // A brand-new joiner is refused...
    const outsider = await upsertUser(identity("lock-outsider", "Outsider"), env.DB);
    await expect(acceptInvite(created.inviteId, outsider.id, env.DB)).resolves.toBe("locked");
    // ...but an existing member's idempotent re-accept still works.
    await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);

    await expect(setSessionLocked(created.session.id, owner.id, false, env.DB)).resolves.toEqual({ lockedAt: null });
    // The same invite ID works again — nothing was rotated or revoked.
    await expect(acceptInvite(created.inviteId, outsider.id, env.DB)).resolves.toBe(created.session.id);
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
    }, "main", env.DB)).rejects.toBeInstanceOf(SessionEndedError);
    await expect(createAgentRun(created.session.id, "missing-queue-item", owner.id, "task", env.DB)).rejects.toBeInstanceOf(SessionEndedError);
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
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM storage_cleanup_prefixes WHERE source_session_id = ?").bind(stale.session.id).first<{ count: number }>())?.count).toBeGreaterThan(0);
  });

  it("bounds each retention purge sweep", async () => {
    const marker = crypto.randomUUID();
    const now = Date.now();
    const staleAt = now - ENDED_SESSION_RETENTION_MS - 1_000;
    await env.DB.batch(Array.from({ length: ENDED_SESSION_PURGE_BATCH_SIZE + 1 }, (_, index) => env.DB.prepare(
      `INSERT INTO sessions (id, title, created_at, updated_at, objective_updated_at, ended_at, ended_reason)
       VALUES (?, ?, ?, ?, ?, ?, 'owner')`,
    ).bind(crypto.randomUUID(), `Purge batch ${marker}-${index}`, staleAt, staleAt, staleAt, staleAt)));

    expect(await purgeExpiredSessions(env.DB, now)).toHaveLength(ENDED_SESSION_PURGE_BATCH_SIZE);
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE title LIKE ?",
    ).bind(`Purge batch ${marker}-%`).first<{ count: number }>();
    expect(remaining?.count).toBe(1);
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
    expect((await env.DB.prepare("SELECT 1 AS present FROM storage_cleanup_prefixes WHERE prefix = ?").bind(`sessions/${created.session.id}/`).first())?.present).toBe(1);
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toBe("missing");
  });

  it("reports a live candidate instead of refusing outright, and allows deletion once merged", async () => {
    const owner = await upsertUser(identity("delete-repository-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Repository audit", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-delete", {
      id: "repository-delete", nodeId: "R_delete", owner: "openfloor-test", name: "audit",
      fullName: "openfloor-test/audit", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Audit room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    // Unmerged: deletion no longer dead-ends — it hands back the branch so
    // the caller (app/api/sessions/[id]/route.ts) can offer the owner a
    // choice (ENG-83), instead of the old bare "repository_state" refusal.
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toEqual({
      blocked: "candidate_live", branch, sha: "a".repeat(40),
    });
    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).not.toBeNull();

    // Merged, branch not yet deleted: deletion proceeds and flags the surviving branch.
    await markCandidateMerged(created.session.id, candidateId, owner.id, "b".repeat(40), env.DB);
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toEqual({ deleted: true, candidateBranchAlive: true });
    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).toBeNull();
  });

  it("abandons a live candidate (keeping the branch) so a fresh one can be created, and lets deletion proceed", async () => {
    const owner = await upsertUser(identity("abandon-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Abandon room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-abandon", {
      id: "repository-abandon", nodeId: "R_abandon", owner: "openfloor-test", name: "abandon",
      fullName: "openfloor-test/abandon", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Abandon room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    // The integration lease refuses abandonment the same way it refuses
    // merge/end/delete.
    await env.DB.prepare("UPDATE repository_candidates SET integration_run_id = ? WHERE id = ?").bind("leased-run", candidateId).run();
    await expect(abandonSessionCandidate(created.session.id, owner.id, { deleteBranch: false }, env.DB)).resolves.toEqual({ outcome: "blocked", runId: "leased-run" });
    await env.DB.prepare("UPDATE repository_candidates SET integration_run_id = NULL WHERE id = ?").bind(candidateId).run();

    // Keeping the branch touches no GitHub/Sandbox binding — only D1.
    const result = await abandonSessionCandidate(created.session.id, owner.id, { deleteBranch: false }, env.DB);
    expect(result).toMatchObject({ outcome: "abandoned", branch, branchDeleted: false });
    const abandonedRow = await env.DB.prepare("SELECT abandoned_at AS abandonedAt FROM repository_candidates WHERE id = ?").bind(candidateId).first<{ abandonedAt: number | null }>();
    expect(abandonedRow?.abandonedAt).not.toBeNull();

    // The connection drops back from 'ready' to 'connected' — otherwise the
    // repository/candidate route's POST guard (which requires 'connected')
    // would refuse the rename/retry flow the simplified repository card
    // relies on right after an abandon.
    await expect(getRepositoryConnectionForMember(created.session.id, owner.id, env.DB))
      .resolves.toEqual(expect.objectContaining({ status: "connected" }));

    // The one-live-candidate index is freed: a fresh candidate can be
    // reserved for the same session immediately.
    const nextCandidateId = crypto.randomUUID();
    const nextBranch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${nextCandidateId.slice(0, 8)}`;
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, nextCandidateId, "Abandon room take two", "", nextBranch, "main", "a".repeat(40), env.DB)).resolves.toBe(true);

    // Clear the second candidate too so only its abandonment state — not its
    // liveness — is what the deletion assertion below is exercising.
    await markCandidateAbandoned(created.session.id, nextCandidateId, env.DB);

    // Deletion (choosing to orphan the abandoned branches) now proceeds and
    // flags a surviving branch, the same warning shape as a merged one.
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toEqual({ deleted: true, candidateBranchAlive: true });
    expect(await getSessionForMember(created.session.id, owner.id, env.DB)).toBeNull();
  });

  it("persists one owner-configured repository connection", async () => {
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
      env.DB,
    );
    expect(saved).toEqual(expect.objectContaining({
      repositoryId: "repository-1",
      repositoryFullName: "openfloor-test/repository-integration",
      status: "connected",
    }));
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
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Candidate room", "Coordinate candidate work", branch, "main", "a".repeat(40), env.DB)).resolves.toBe(true);
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, crypto.randomUUID(), "Another candidate", "", `${branch}x`, "main", "a".repeat(40), env.DB)).resolves.toBe(false);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    expect(await getActiveRepositoryCandidateForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ name: "Candidate room", description: "Coordinate candidate work", branchName: branch, behindBase: false }));

    await expect(recordGitHubWebhookDelivery("delivery-1", "push", null, "installation-2", "repository-2", env.DB)).resolves.toBe(true);
    await expect(recordGitHubWebhookDelivery("delivery-1", "push", null, "installation-2", "repository-2", env.DB)).resolves.toBe(false);
    await expect(releaseGitHubWebhookDelivery("delivery-1", env.DB)).resolves.toBeUndefined();
    await expect(recordGitHubWebhookDelivery("delivery-1", "push", null, "installation-2", "repository-2", env.DB)).resolves.toBe(true);
    const [target] = await findRepositoryWebhookTargets("installation-2", "repository-2", env.DB);
    await updateRepositoryPushState(target.sessionId, "refs/heads/main", "b".repeat(40), target.baseBranch, target.candidateBranch, target.candidateSha, target.integrationRunId, env.DB);
    expect(await getActiveRepositoryCandidateForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ behindBase: true, remoteBaseSha: "b".repeat(40) }));
    await updateRepositoryPushState(target.sessionId, `refs/heads/${branch}`, "c".repeat(40), target.baseBranch, target.candidateBranch, target.candidateSha, target.integrationRunId, env.DB);
    expect(await getRepositoryConnectionForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ status: "externally_modified" }));
  });

  it("forces manually targeted Concierge code requests through a reactivated read-only reply run", async () => {
    const owner = await upsertUser(identity("concierge-safe-owner", "Concierge Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Concierge safety", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-concierge", {
      id: "repository-concierge", nodeId: "R_concierge", owner: "openfloor-test", name: "concierge",
      fullName: "openfloor-test/concierge", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Concierge safety", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    const conciergeId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO floor_agents (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, provider, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Concierge', 'concierge', 'Session answers', 'Answer questions', 'created', 'openai', 'answer', ?, ?)`,
    ).bind(conciergeId, created.session.id, owner.id, owner.id, now, now).run();
    const floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Implement a writable code change", agentId: conciergeId }, env.DB);
    const queueItemId = floor!.queue[0].id;
    await env.DB.prepare("UPDATE floor_agents SET deprovisioned_at = ? WHERE id = ?").bind(now, conciergeId).run();

    const run = await createAgentRun(created.session.id, queueItemId, owner.id, "task", env.DB);
    expect(run.kind).toBe("reply");
    expect(run.runBranch).toBeNull();
    expect(run.checks).toEqual([]);
    const agent = await env.DB.prepare("SELECT deprovisioned_at AS deprovisionedAt FROM floor_agents WHERE id = ?")
      .bind(conciergeId).first<{ deprovisionedAt: number | null }>();
    expect(agent?.deprovisionedAt).toBeNull();
    await finishAgentReply(run.id, "ready", "I can explain the requested change, but Concierge cannot modify code.", "Answered read-only.", null, env.DB);
    const updated = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(updated?.queue[0].status).toBe("completed");
    expect(updated?.runs[0]).toEqual(expect.objectContaining({ kind: "reply", runBranch: null }));
  });

  it("resumes an eligible earlier attempt's provider thread and never serves its session store", async () => {
    const owner = await upsertUser(identity("resume-owner", "Resume Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Resume room", objective: "Continue the thread" }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-resume", {
      id: "repository-resume", nodeId: "R_resume", owner: "openfloor-test", name: "resume",
      fullName: "openfloor-test/resume", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Resume room", "Continue the thread", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    const parsed = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement the request", ownerUserId: owner.id });
    if (!parsed) throw new Error("Invalid agent fixture");
    let floor = await createFloorAgent(created.session.id, owner.id, parsed, env.DB);
    const agentId = floor!.agents[0].id;
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Add a real file", agentId }, env.DB);
    const queueItemId = floor!.queue[0].id;

    // Attempt 1 crashes: its thread id survives (markRunChecking never ran)
    // and its session store is recorded, but never listed for members.
    const first = await createAgentRun(created.session.id, queueItemId, owner.id, "task", env.DB);
    expect(first).toEqual(expect.objectContaining({ resumedFromRunId: null, resumedFromAttempt: null, providerThreadResumed: null }));
    await markRunRunning(first.id, "process-1", env.DB);
    await setRunProviderThreadId(first.id, "thread-1", null, env.DB);
    await recordRunArtifact(first.id, "session_store", `runs/${first.id}/session-store.tgz`, "application/gzip", 1234, env.DB);
    await recordRunArtifact(first.id, "codex_log", `runs/${first.id}/codex.log`, "text/plain", 10, env.DB);
    await finishAgentRun(first.id, "failed", "Crashed", env.DB);
    const stored = await env.DB.prepare("SELECT codex_thread_id AS threadId FROM agent_runs WHERE id = ?").bind(first.id).first<{ threadId: string | null }>();
    expect(stored?.threadId).toBe("thread-1");
    expect((await getRunArtifactKeysForMember(created.session.id, first.id, owner.id, env.DB))?.map((artifact) => artifact.kind)).toEqual(["codex_log"]);

    // Un-pausing the failed item re-runs it; attempt 2 resumes attempt 1.
    expect(await setFloorQueueItemPaused(created.session.id, owner.id, queueItemId, false, env.DB)).not.toBeNull();
    const second = await createAgentRun(created.session.id, queueItemId, owner.id, "task", env.DB);
    expect(second).toEqual(expect.objectContaining({ attempt: 2, resumedFromRunId: first.id, resumedFromAttempt: 1, providerThreadResumed: null }));
    expect(await getRunExecutionContext(second.id, env.DB)).toEqual(expect.objectContaining({
      resumeThreadId: "thread-1", resumedFromAttempt: 1, resumedFromStatus: "failed", resumeSessionStoreKey: `runs/${first.id}/session-store.tgz`,
    }));
    await markRunRunning(second.id, "process-2", env.DB);
    await setRunProviderThreadId(second.id, null, false, env.DB);
    expect((await getAgentRun(second.id, env.DB))).toEqual(expect.objectContaining({ providerThreadResumed: 0 }));
    await setRunProviderThreadId(second.id, "thread-1", true, env.DB);
    await recordRunArtifact(second.id, "session_store", `runs/${second.id}/session-store.tgz`, "application/gzip", 2345, env.DB);
    await finishAgentRun(second.id, "cancelled", "Cancelled", env.DB);
    expect((await getAgentRun(second.id, env.DB))).toEqual(expect.objectContaining({ providerThreadResumed: 1 }));

    // A system-originated follow-up names its source run explicitly and
    // resumes that thread even though the queue item differs.
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "CI is failing on your PR.", agentId }, env.DB);
    const followUpId = floor!.queue.find((item) => item.id !== queueItemId)!.id;
    await env.DB.prepare("UPDATE floor_queue_items SET source_run_id = ? WHERE id = ?").bind(second.id, followUpId).run();
    const followUp = await createAgentRun(created.session.id, followUpId, owner.id, "task", env.DB);
    expect(followUp).toEqual(expect.objectContaining({ attempt: 1, resumedFromRunId: second.id, resumedFromAttempt: 2 }));
    await finishAgentRun(followUp.id, "cancelled", "Cancelled", env.DB);

    // A model change breaks eligibility: the next attempt starts fresh.
    await env.DB.prepare("UPDATE floor_agents SET model = 'gpt-5.6-terra-other' WHERE id = ?").bind(agentId).run();
    expect(await setFloorQueueItemPaused(created.session.id, owner.id, queueItemId, false, env.DB)).not.toBeNull();
    const third = await createAgentRun(created.session.id, queueItemId, owner.id, "task", env.DB);
    expect(third).toEqual(expect.objectContaining({ attempt: 3, model: "gpt-5.6-terra-other", resumedFromRunId: null }));
    expect(await getRunExecutionContext(third.id, env.DB)).toEqual(expect.objectContaining({ resumeThreadId: null, resumeSessionStoreKey: null }));
  });

  it("persists owner-gated agent runs, real files, checks, retry, and cancellation", async () => {
    const owner = await upsertUser(identity("run-owner", "Run Owner"), env.DB);
    const member = await upsertUser(identity("run-member", "Run Member"), env.DB);
    const created = await createSession(owner.id, { title: "Run room", objective: "Make a focused change" }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-run", {
      id: "repository-run", nodeId: "R_run", owner: "openfloor-test", name: "run",
      fullName: "openfloor-test/run", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Run room", "Make a focused change", branch, "main", "d".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "d".repeat(40), env.DB);
    const parsed = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement the request", ownerUserId: owner.id });
    if (!parsed) throw new Error("Invalid agent fixture");
    let floor = await createFloorAgent(created.session.id, owner.id, parsed, env.DB);
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Add a real file", agentId: floor!.agents[0].id }, env.DB);
    const queueItemId = floor!.queue[0].id;
    await expect(createAgentRun(created.session.id, queueItemId, member.id, "task", env.DB)).rejects.toBeInstanceOf(AgentRunNotReadyError);
    const run = await createAgentRun(created.session.id, queueItemId, owner.id, "task", env.DB);
    expect(run).toEqual(expect.objectContaining({ status: "provisioning", model: "gpt-5.6-terra", attempt: 1 }));
    const context = await getRunExecutionContext(run.id, env.DB);
    expect(context).toEqual(expect.objectContaining({ candidateSha: "d".repeat(40), agentName: "Builder" }));
    await markRunRunning(run.id, "process-1", env.DB);
    await markRunChecking(run.id, "thread-1", "Implemented", env.DB);
    await replaceRunFiles(run.id, [{ path: "src/change.ts", changeKind: "add", additions: 1, deletions: 0, summary: null, diffPreview: "+export const changed = true;" }], env.DB);
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

    // Publication already gets three Workflow retries. If they all fail, the
    // durable state must become actionable instead of parking forever in the
    // active "publishing" status (ENG-187).
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Exercise a failed publication", agentId: floor!.agents[0].id }, env.DB);
    const publicationItem = floor!.queue.find((item) => item.prompts[0]?.text === "Exercise a failed publication")!;
    const publicationFailure = await createAgentRun(created.session.id, publicationItem.id, owner.id, "task", env.DB);
    await markRunRunning(publicationFailure.id, "process-publication-failure", env.DB);
    await markRunChecking(publicationFailure.id, "thread-publication-failure", "Implemented", env.DB);
    await replaceRunFiles(publicationFailure.id, [{ path: "src/publication-failure.ts", changeKind: "add", additions: 1, deletions: 0, summary: null, diffPreview: "+export const ready = true;" }], env.DB);
    await finishAgentRun(publicationFailure.id, "ready", "Ready locally", env.DB);
    await markRunPublishing(publicationFailure.id, { bundleKey: "publication-failure.bundle", bundleSizeBytes: 20, localCommitSha: "6".repeat(40) }, env.DB);
    await recordRunPublicationFailure(publicationFailure.id, "GitHub refused the run branch", env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.queue.find((item) => item.id === publicationItem.id)?.status).toBe("failed");
    expect(floor?.runs.find((item) => item.id === publicationFailure.id)).toEqual(expect.objectContaining({
      status: "failed",
      summary: "GitHub refused the run branch",
      completedAt: expect.any(Number),
    }));

    expect(await markRunDiscarded(created.session.id, run.id, member.id, env.DB)).toBeNull();
    expect(await markRunDiscarded(created.session.id, run.id, owner.id, env.DB)).toBeNull();
    await finishAgentRun(run.id, "failed", "Late duplicate completion", env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.queue[0].status).toBe("completed");
    expect(floor?.runs.find((item) => item.id === run.id)?.status).toBe("integrated");

    await env.DB.prepare("UPDATE floor_queue_items SET status = 'queued' WHERE id = ?").bind(queueItemId).run();
    const conflict = await createAgentRun(created.session.id, queueItemId, owner.id, "task", env.DB);
    await markRunRunning(conflict.id, "process-conflict", env.DB);
    await markRunChecking(conflict.id, "thread-conflict", "Conflicting change", env.DB);
    await replaceRunFiles(conflict.id, [{ path: "src/conflict.ts", changeKind: "add", additions: 1, deletions: 0, summary: null, diffPreview: "+conflict" }], env.DB);
    await finishAgentRun(conflict.id, "ready", "Ready", env.DB);
    await markRunPublishing(conflict.id, { bundleKey: "conflict.bundle", bundleSizeBytes: 20, localCommitSha: "8".repeat(40) }, env.DB);
    await finishRunPublished(conflict.id, "7".repeat(40), "7".repeat(40), env.DB);
    await beginRunIntegration(conflict.id, env.DB);
    await markRunIntegrationConflicted(conflict.id, "Both runs changed src/conflict.ts", env.DB);
    expect(await prepareConflictedRunRetry(created.session.id, conflict.id, member.id, env.DB)).toBeNull();
    expect(await prepareConflictedRunRetry(created.session.id, conflict.id, owner.id, env.DB)).toBe(queueItemId);
    const retry = await createAgentRun(created.session.id, queueItemId, owner.id, "task", env.DB);
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
    // Converting back to a draft flips pull_request_draft without erasing the
    // first-ready audit trail, and marking ready again keeps that original stamp.
    await markCandidateReviewDraft(created.session.id, candidateId, env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.review).toEqual(expect.objectContaining({ status: "draft", pullRequest: expect.objectContaining({ draft: true }) }));
    const readyAudit = await env.DB.prepare("SELECT review_ready_at, review_ready_by FROM repository_candidates WHERE id = ?")
      .bind(candidateId).first<{ review_ready_at: number | null; review_ready_by: string | null }>();
    expect(readyAudit?.review_ready_at).not.toBeNull();
    expect(readyAudit?.review_ready_by).toBe(owner.id);
    await markCandidateReviewReady(created.session.id, candidateId, owner.id, env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.review).toEqual(expect.objectContaining({ status: "ready", pullRequest: expect.objectContaining({ draft: false }) }));
    const unlockedRevision = floor!.revision;
    await setCandidateMergeLocked(created.session.id, candidateId, true, env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.revision).toBeGreaterThan(unlockedRevision);
    expect(floor?.review?.mergeLockedAt).not.toBeNull();
    await setCandidateMergeLocked(created.session.id, candidateId, false, env.DB);
    floor = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(floor?.review?.mergeLockedAt).toBeNull();
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

  it("provides review sync context for active members (owner and regular member)", async () => {
    const owner = await upsertUser(identity("sync-ctx-owner", "Sync Owner"), env.DB);
    const member = await upsertUser(identity("sync-ctx-member", "Sync Member"), env.DB);
    const outsider = await upsertUser(identity("sync-ctx-outsider", "Sync Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Sync Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-sync-ctx", {
      id: "repository-sync-ctx", nodeId: "R_sync_ctx", owner: "openfloor-test", name: "sync-repo",
      fullName: "openfloor-test/sync-repo", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Sync Room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);

    const ownerContext = await getCandidateReviewSyncContext(created.session.id, owner.id, env.DB);
    expect(ownerContext).toEqual(expect.objectContaining({
      candidateId,
      candidateBranch: branch,
      installationId: "installation-sync-ctx",
      repositoryName: "sync-repo",
      connectionStatus: "ready",
    }));

    const memberContext = await getCandidateReviewSyncContext(created.session.id, member.id, env.DB);
    expect(memberContext).toEqual(expect.objectContaining({
      candidateId,
      candidateBranch: branch,
      installationId: "installation-sync-ctx",
    }));

    const outsiderContext = await getCandidateReviewSyncContext(created.session.id, outsider.id, env.DB);
    expect(outsiderContext).toBeNull();
  });

  it("blocks end/delete while a run is integrating and unblocks once that run is cancelled", async () => {
    const owner = await upsertUser(identity("integrating-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Integration room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-integrating", {
      id: "repository-integrating", nodeId: "R_integrating", owner: "openfloor-test", name: "integrating",
      fullName: "openfloor-test/integrating", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Integration room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    const parsed = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement the request", ownerUserId: owner.id });
    if (!parsed) throw new Error("Invalid agent fixture");
    let floor = await createFloorAgent(created.session.id, owner.id, parsed, env.DB);
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Add a real file", agentId: floor!.agents[0].id }, env.DB);
    const run = await createAgentRun(created.session.id, floor!.queue[0].id, owner.id, "task", env.DB);
    await markRunRunning(run.id, "process-1", env.DB);
    await markRunChecking(run.id, "thread-1", "Implemented", env.DB);
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

    // The candidate's lock is clear now, so ending proceeds — deleting no
    // longer refuses outright, but still reports the live, unmerged
    // candidate back so the caller can choose its fate (ENG-83).
    await expect(endSession(created.session.id, owner.id, "owner", env.DB)).resolves.toEqual({ endedAt: expect.any(Number), reason: "owner" });
    await expect(deleteSession(created.session.id, owner.id, env.DB)).resolves.toEqual({ blocked: "candidate_live", branch, sha: "a".repeat(40) });
  });

  it("endMergedSession ends a session even while a run holds the integration lock", async () => {
    const owner = await upsertUser(identity("merged-integrating-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "External merge room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-merged-integrating", {
      id: "repository-merged-integrating", nodeId: "R_merged_integrating", owner: "openfloor-test", name: "merged-integrating",
      fullName: "openfloor-test/merged-integrating", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "External merge room", "", branch, "main", "a".repeat(40), env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    const parsed = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement the request", ownerUserId: owner.id });
    if (!parsed) throw new Error("Invalid agent fixture");
    let floor = await createFloorAgent(created.session.id, owner.id, parsed, env.DB);
    floor = await createFloorQueueItem(created.session.id, owner.id, { prompt: "Add a real file", agentId: floor!.agents[0].id }, env.DB);
    const run = await createAgentRun(created.session.id, floor!.queue[0].id, owner.id, "task", env.DB);
    await markRunRunning(run.id, "process-merged", env.DB);
    await markRunChecking(run.id, "thread-merged", "Implemented", env.DB);
    await finishAgentRun(run.id, "ready", "Ready locally", env.DB);
    const publishedSha = "e".repeat(40);
    await markRunPublishing(run.id, { bundleKey: `runs/${run.id}/result.bundle`, bundleSizeBytes: 100, localCommitSha: "f".repeat(40) }, env.DB);
    await finishRunPublished(run.id, publishedSha, publishedSha, env.DB);
    await beginRunIntegration(run.id, env.DB);

    // The GitHub merge already happened — it must end the session even
    // though a run still holds the candidate's integration lock, unlike
    // endSession which refuses in that state.
    await expect(endSession(created.session.id, owner.id, "owner", env.DB)).resolves.toEqual({ blocked: "integration_in_progress", runId: run.id });
    await expect(endMergedSession(created.session.id, env.DB)).resolves.toEqual({ endedAt: expect.any(Number) });
    const row = await env.DB.prepare("SELECT ended_at AS endedAt, ended_reason AS endedReason FROM sessions WHERE id = ?").bind(created.session.id).first<{ endedAt: number | null; endedReason: string | null }>();
    expect(row?.endedAt).not.toBeNull();
    expect(row?.endedReason).toBe("merged");

    // Idempotent: an already-ended session returns null rather than
    // re-writing ended_at, matching a replayed webhook delivery.
    await expect(endMergedSession(created.session.id, env.DB)).resolves.toBeNull();
  });

  it("rolls back one integrated prompt for its engineer or agent owner while preserving run audit", async () => {
    const owner = await upsertUser(identity("rollback-owner", "Rollback Owner"), env.DB);
    const agentOwner = await upsertUser(identity("rollback-agent-owner", "Agent Owner"), env.DB);
    const engineer = await upsertUser(identity("rollback-engineer", "Prompt Engineer"), env.DB);
    const other = await upsertUser(identity("rollback-other", "Other Member"), env.DB);
    const created = await createSession(owner.id, { title: "Rollback room", objective: "Undo one integrated prompt" }, env.DB);
    await acceptInvite(created.inviteId, agentOwner.id, env.DB);
    await acceptInvite(created.inviteId, engineer.id, env.DB);
    await acceptInvite(created.inviteId, other.id, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-rollback", {
      id: "repository-rollback", nodeId: "R_rollback", owner: "openfloor-test", name: "rollback",
      fullName: "openfloor-test/rollback", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    const initialSha = "1".repeat(40);
    await reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, "Rollback room", "", branch, "main", initialSha, env.DB);
    await activateRepositoryCandidate(created.session.id, candidateId, initialSha, env.DB);
    const parsed = parseAgentInput({ name: "Reverter", role: "Engineer", task: "Implement prompts", ownerUserId: agentOwner.id });
    if (!parsed) throw new Error("Invalid rollback agent fixture");
    let floor = await createFloorAgent(created.session.id, agentOwner.id, parsed, env.DB);
    floor = await createFloorQueueItem(created.session.id, engineer.id, { prompt: "Add the reversible change", agentId: floor!.agents[0].id }, env.DB);
    const run = await createAgentRun(created.session.id, floor!.queue[0].id, owner.id, "task", env.DB);
    await markRunRunning(run.id, "rollback-process", env.DB);
    await markRunChecking(run.id, "rollback-thread", "Implemented reversible change", env.DB);
    await replaceRunFiles(run.id, [{ path: "src/reversible.ts", changeKind: "add", additions: 1, deletions: 0, summary: null, diffPreview: "+export const reversible = true;" }], env.DB);
    await finishAgentRun(run.id, "ready", "Ready", env.DB);
    const publishedSha = "2".repeat(40);
    await markRunPublishing(run.id, { bundleKey: "rollback.bundle", bundleSizeBytes: 10, localCommitSha: publishedSha }, env.DB);
    await finishRunPublished(run.id, publishedSha, publishedSha, env.DB);
    await beginRunIntegration(run.id, env.DB);
    const integratedSha = "3".repeat(40);
    await finishRunIntegrated(run.id, integratedSha, { number: 4, nodeId: "PR_rollback", url: "https://github.com/openfloor-test/rollback/pull/4", state: "open", draft: true }, env.DB);

    await expect(createAgentRunRollback(created.session.id, run.id, other.id, env.DB)).resolves.toBeNull();
    const engineerAttempt = await createAgentRunRollback(created.session.id, run.id, engineer.id, env.DB);
    expect(engineerAttempt).not.toBeNull();
    await beginAgentRunRollback(engineerAttempt!.rollbackId, env.DB);
    await failAgentRunRollback(engineerAttempt!.rollbackId, "Rollback conflicts with later candidate changes", env.DB);
    expect((await getFloorSnapshot(created.session.id, engineer.id, env.DB))?.runs[0]).toEqual(expect.objectContaining({
      status: "integrated", rollbackStatus: "failed", rollbackFailureReason: "Rollback conflicts with later candidate changes",
    }));

    const agentOwnerAttempt = await createAgentRunRollback(created.session.id, run.id, agentOwner.id, env.DB);
    expect(agentOwnerAttempt).not.toBeNull();
    await beginAgentRunRollback(agentOwnerAttempt!.rollbackId, env.DB);
    const rollbackSha = "4".repeat(40);
    const revisionBeforeStaleFinish = (await getFloorSnapshot(created.session.id, owner.id, env.DB))!.revision;
    await env.DB.prepare("UPDATE repository_candidates SET integration_run_id = 'another-operation' WHERE id = ?")
      .bind(candidateId).run();
    await expect(finishAgentRunRollback(agentOwnerAttempt!.rollbackId, rollbackSha, env.DB))
      .rejects.toThrow("candidate changed");
    const afterStaleFinish = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(afterStaleFinish?.revision).toBe(revisionBeforeStaleFinish);
    expect(afterStaleFinish?.runs[0]).toEqual(expect.objectContaining({ rollbackStatus: "running" }));
    expect(afterStaleFinish?.review?.files).toHaveLength(1);

    await env.DB.prepare("UPDATE repository_candidates SET integration_run_id = ? WHERE id = ?")
      .bind(run.id, candidateId).run();
    await finishAgentRunRollback(agentOwnerAttempt!.rollbackId, rollbackSha, env.DB);
    const after = await getFloorSnapshot(created.session.id, owner.id, env.DB);
    expect(after?.runs[0]).toEqual(expect.objectContaining({
      id: run.id, status: "integrated", integratedCandidateSha: integratedSha,
      rollbackStatus: "completed", rollbackExpectedCandidateSha: integratedSha, rollbackCommitSha: rollbackSha,
    }));
    expect(after?.activeCandidate).toEqual(expect.objectContaining({ candidateSha: rollbackSha }));
    expect(after?.review?.files).toEqual([]);
    expect((await getSessionContext(created.session.id, undefined, env.DB))?.integratedRuns).toEqual([]);
    await expect(createAgentRunRollback(created.session.id, run.id, owner.id, env.DB)).rejects.toThrow("already rolled back");
  });

  it("paginates candidate contributions and atomically rolls back owner-selected groups", async () => {
    const owner = await upsertUser(identity("group-rollback-owner", "Group Owner"), env.DB);
    const engineer = await upsertUser(identity("group-rollback-engineer", "Engineer One"), env.DB);
    const collaborator = await upsertUser(identity("group-rollback-collaborator", "Engineer Two"), env.DB);
    const outsider = await upsertUser(identity("group-rollback-outsider", "Outside Member"), env.DB);
    const created = await createSession(owner.id, { title: "Atomic rollback room", objective: "Review every contribution" }, env.DB);
    await acceptInvite(created.inviteId, engineer.id, env.DB);
    await acceptInvite(created.inviteId, collaborator.id, env.DB);
    await acceptInvite(created.inviteId, outsider.id, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-group-rollback", {
      id: "repository-group-rollback", nodeId: "R_group_rollback", owner: "openfloor-test", name: "group-rollback",
      fullName: "openfloor-test/group-rollback", private: true, defaultBranch: "main",
    }, "main", env.DB);
    const candidateId = crypto.randomUUID();
    const initialSha = "a".repeat(40);
    await reserveRepositoryCandidate(
      created.session.id,
      owner.id,
      saved!.id,
      candidateId,
      "Atomic rollback room",
      "",
      `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`,
      "main",
      initialSha,
      env.DB,
    );
    await activateRepositoryCandidate(created.session.id, candidateId, initialSha, env.DB);
    const parsed = parseAgentInput({ name: "Group Builder", role: "Engineer", task: "Implement grouped prompts", ownerUserId: owner.id });
    if (!parsed) throw new Error("Invalid group rollback agent fixture");
    let floor = await createFloorAgent(created.session.id, owner.id, parsed, env.DB);
    const agentId = floor!.agents[0].id;
    const runIds: string[] = [];
    const baseTime = Date.now() - 100_000;
    for (let index = 0; index < 22; index += 1) {
      floor = await createFloorQueueItem(created.session.id, engineer.id, { prompt: `Contribution ${index}`, agentId }, env.DB);
      const queueItem = floor!.queue.find((item) => item.prompts.some((prompt) => prompt.text === `Contribution ${index}`));
      if (!queueItem) throw new Error("Missing group rollback queue fixture");
      if (index === 5) {
        await env.DB.prepare(
          `INSERT INTO floor_queue_prompts (id, queue_item_id, author_user_id, text, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), queueItem.id, collaborator.id, "Shared contribution", baseTime + index).run();
      }
      const run = await createAgentRun(created.session.id, queueItem.id, owner.id, "task", env.DB);
      const integratedSha = index.toString(16).padStart(40, "0");
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE agent_runs SET status = 'integrated', integrated_candidate_sha = ?, integrated_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
        ).bind(integratedSha, baseTime + index, baseTime + index, baseTime + index, run.id),
        env.DB.prepare("UPDATE floor_queue_items SET status = 'completed', updated_at = ? WHERE id = ?")
          .bind(baseTime + index, queueItem.id),
        env.DB.prepare(
          `INSERT INTO agent_run_files (id, run_id, path, change_kind, additions, deletions, summary, diff_preview, created_at)
           VALUES (?, ?, ?, 'update', 1, 0, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), run.id, `src/contribution-${index}.ts`, `Contribution ${index}`, `+export const contribution${index} = true;`, baseTime + index),
      ]);
      runIds.push(run.id);
    }

    const firstPage = await listReviewContributions(created.session.id, engineer.id, { status: "active", limit: 20 }, env.DB);
    expect(firstPage?.items).toHaveLength(20);
    expect(firstPage?.nextCursor).not.toBeNull();
    const secondPage = await listReviewContributions(created.session.id, engineer.id, { status: "active", limit: 20, cursor: firstPage!.nextCursor }, env.DB);
    expect(secondPage?.items).toHaveLength(2);
    expect(new Set([...firstPage!.items, ...secondPage!.items].map((item) => item.runId)).size).toBe(22);
    expect(await listReviewContributions(created.session.id, "not-a-member", { status: "active" }, env.DB)).toBeNull();
    expect(await getReviewContribution(created.session.id, runIds[0], "not-a-member", env.DB)).toBeNull();

    const engineerImpact = await resolveReviewRollbackImpact(created.session.id, owner.id, "engineer", engineer.id, env.DB);
    expect(engineerImpact?.targets).toHaveLength(21);
    expect(engineerImpact?.excluded).toEqual([
      expect.objectContaining({ runId: runIds[5], exclusionReason: "Merged with prompts from another engineer" }),
    ]);
    await expect(resolveReviewRollbackImpact(created.session.id, engineer.id, "engineer", engineer.id, env.DB)).resolves.toBeNull();
    await expect(resolveReviewRollbackImpact(created.session.id, outsider.id, "prompt", runIds[5], env.DB)).resolves.toBeNull();
    expect((await resolveReviewRollbackImpact(created.session.id, owner.id, "agent", agentId, env.DB))?.targets).toHaveLength(22);
    await expect(createAgentRunRollbackGroup(created.session.id, owner.id, {
      scope: "engineer",
      subjectId: engineer.id,
      expectedCandidateSha: "b".repeat(40),
      expectedRunIds: engineerImpact!.targets.map((target) => target.runId),
    }, env.DB)).rejects.toThrow("contributions changed");
    await expect(createAgentRunRollbackGroup(created.session.id, owner.id, {
      scope: "engineer",
      subjectId: engineer.id,
      expectedCandidateSha: engineerImpact!.expectedCandidateSha,
      expectedRunIds: engineerImpact!.targets.slice(1).map((target) => target.runId),
    }, env.DB)).rejects.toThrow("contributions changed");

    const group = await createAgentRunRollbackGroup(created.session.id, owner.id, {
      scope: "engineer",
      subjectId: engineer.id,
      expectedCandidateSha: engineerImpact!.expectedCandidateSha,
      expectedRunIds: engineerImpact!.targets.map((target) => target.runId),
    }, env.DB);
    const context = await beginAgentRunRollbackGroup(group!.groupId, env.DB);
    expect(context.targets.map((target) => target.integratedAt)).toEqual([...context.targets.map((target) => target.integratedAt)].sort((a, b) => b - a));
    await failAgentRunRollbackGroup(group!.groupId, "Rollback conflicts with changes integrated later in the candidate", env.DB);
    const failedChildren = await env.DB.prepare(
      `SELECT DISTINCT rb.status, rb.failure_reason AS failureReason
       FROM agent_run_rollbacks rb JOIN agent_run_rollback_group_items item ON item.rollback_id = rb.id
       WHERE item.group_id = ?`,
    ).bind(group!.groupId).all<{ status: string; failureReason: string }>();
    expect(failedChildren.results).toEqual([{ status: "failed", failureReason: "Rollback conflicts with changes integrated later in the candidate" }]);

    const retryImpact = await resolveReviewRollbackImpact(created.session.id, owner.id, "prompt", runIds[0], env.DB);
    const retry = await createAgentRunRollbackGroup(created.session.id, owner.id, {
      scope: "prompt",
      subjectId: runIds[0],
      expectedCandidateSha: retryImpact!.expectedCandidateSha,
      expectedRunIds: [runIds[0]],
    }, env.DB);
    await beginAgentRunRollbackGroup(retry!.groupId, env.DB);
    const rollbackSha = "f".repeat(40);
    await finishAgentRunRollbackGroup(retry!.groupId, rollbackSha, env.DB);
    const completed = await env.DB.prepare(
      `SELECT g.status AS groupStatus, rb.status AS childStatus, g.rollback_commit_sha AS groupSha, rb.rollback_commit_sha AS childSha
       FROM agent_run_rollback_groups g JOIN agent_run_rollback_group_items item ON item.group_id = g.id
       JOIN agent_run_rollbacks rb ON rb.id = item.rollback_id WHERE g.id = ?`,
    ).bind(retry!.groupId).first<{ groupStatus: string; childStatus: string; groupSha: string; childSha: string }>();
    expect(completed).toEqual({ groupStatus: "completed", childStatus: "completed", groupSha: rollbackSha, childSha: rollbackSha });
    const preservedAttempts = await env.DB.prepare("SELECT status FROM agent_run_rollbacks WHERE run_id = ? ORDER BY created_at, id")
      .bind(runIds[0]).all<{ status: string }>();
    expect(preservedAttempts.results.map((attempt) => attempt.status).sort()).toEqual(["completed", "failed"]);
    expect((await listReviewContributions(created.session.id, owner.id, { status: "active", limit: 100 }, env.DB))?.items).toHaveLength(21);
    expect((await listReviewContributions(created.session.id, owner.id, { status: "rolled_back" }, env.DB))?.items)
      .toEqual([expect.objectContaining({ runId: runIds[0], rollbackStatus: "completed" })]);
    expect((await getFloorSnapshot(created.session.id, owner.id, env.DB))?.queue.find((item) => item.rollback?.runId === runIds[0])?.rollback)
      .toEqual(expect.objectContaining({ status: "completed", canStart: false }));
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

    // A free_allowance_used_at flag (set only by upsertUser recognizing a
    // deleted account's prior_email_hash) drops the free limit itself to 0h
    // — exhausted even with zero seconds booked. Reactivating a paid plan
    // still lifts it regardless.
    await env.DB.prepare("UPDATE users SET plan_status = 'inactive', free_allowance_used_at = ? WHERE id = ?").bind(Date.now(), user.id).run();
    await env.DB.prepare("DELETE FROM usage_months WHERE owner_user_id = ?").bind(user.id).run();
    await expect(hourQuotaExhausted(user.id, env.DB)).resolves.toBe(true);
    await env.DB.prepare("UPDATE users SET plan_status = 'active' WHERE id = ?").bind(user.id).run();
    await expect(hourQuotaExhausted(user.id, env.DB)).resolves.toBe(false);
  });

  it("upsertUser does not reset plan or plan_status on re-login", async () => {
    const user = await upsertUser(identity("plan-persist-user", "Persist"), env.DB);
    await env.DB.prepare("UPDATE users SET plan = 'max', plan_status = 'active' WHERE id = ?").bind(user.id).run();
    const relogged = await upsertUser(identity("plan-persist-user", "Persist"), env.DB);
    expect(relogged.plan).toBe("max");
    expect(relogged.planStatus).toBe("active");
  });

  it("the wind-down set (end, leave, remove, lock, revoke, auto-dispatch off, pause, archive, delete) still works at quota", async () => {
    // The quota gate only sits in front of the operations that spend money —
    // startQueueItemRun and the repository preflight/sync routes — never in
    // front of getActiveMembershipRole itself. Everything here must keep
    // working for an owner who is out of hours, so they can always wind
    // down and never get stuck.
    const owner = await upsertUser(identity("winddown-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("winddown-member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Wind down", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    // Accept before the invite is revoked below — removeMember/setSessionLocked
    // themselves don't touch the invite, but this session's only invite gets
    // revoked a few lines down and a revoked invite can no longer be accepted.
    const removable = await upsertUser(identity("winddown-removable", "Removable"), env.DB);
    await expect(acceptInvite(created.inviteId, removable.id, env.DB)).resolves.toBe(created.session.id);
    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(owner.id, currentMonth(), 2 * 3600)
      .run();
    await expect(hourQuotaExhausted(owner.id, env.DB)).resolves.toBe(true);

    await expect(revokeInvite(created.session.id, owner.id, env.DB)).resolves.toBe(true);
    await expect(setSessionAutoDispatch(created.session.id, owner.id, false, env.DB)).resolves.toBe(true);

    await expect(removeMember(created.session.id, owner.id, removable.id, env.DB)).resolves.toEqual(
      expect.objectContaining({ removedAt: expect.any(Number) }),
    );
    await expect(setSessionLocked(created.session.id, owner.id, true, env.DB)).resolves.toEqual({ lockedAt: expect.any(Number) });
    await expect(setSessionLocked(created.session.id, owner.id, false, env.DB)).resolves.toEqual({ lockedAt: null });

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

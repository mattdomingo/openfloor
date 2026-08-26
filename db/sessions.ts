import { displayNameFrom } from "@/lib/display-name";
import type { AuthenticatedIdentity } from "@/lib/identity";
import { currentMonth, effectivePlan, effectiveSeatLimit, PLAN_LIMITS, type Plan, type PlanStatus } from "@/lib/plans";
import type { AppUser, RemovedSessionMember, SessionMember, SessionRole, SessionSummary } from "@/lib/session-types";
import { getDb, type D1DatabaseLike } from "./index";
import type { CredentialProvider } from "@/lib/provider-credentials";

// Re-exported so existing importers (worker/presence.ts, tests) don't need
// to churn — the model itself lives in lib/plans.ts, which (unlike this
// file) has no cloudflare:workers import and so is reachable from
// tests/unit under plain node.
export { currentMonth, effectivePlan, PLAN_LIMITS };
export type { Plan, PlanStatus };

type SessionRecord = {
  id: string;
  title: string;
  objective: string | null;
  role: SessionRole;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
  objectiveUpdatedAt: number;
  endedAt: number | null;
  endedReason: "owner" | "merged" | null;
  archivedAt: number | null;
  activeSeconds: number;
  lockedAt: number | null;
  autoProvisionAgents: number | boolean;
  autoAgentProvider: CredentialProvider | null;
};

export class SessionEndedError extends Error {
  constructor() {
    super("This session has ended.");
  }
}

export class SessionRoutingError extends Error {}

export type InvitePreview = {
  inviteId: string;
  sessionId: string;
  title: string;
  objective: string | null;
  ownerName: string;
  memberCount: number;
  // The owner's effective seat cap — Infinity for enterprise, same as
  // PLAN_LIMITS. Lets JoinScreen show "This session is full" up front
  // instead of only after a 403 from actually clicking Join.
  seatLimit: number;
  // A locked session still resolves (so a stale bookmark reads as "locked",
  // not as a broken link) but acceptInvite refuses new joins while true.
  locked: boolean;
};

const APP_USER_COLUMNS = `id, chatgpt_user_id AS providerUserId, email, display_name AS displayName,
              first_name AS firstName, last_name AS lastName, github_handle AS githubHandle,
              avatar_key AS avatarKey, onboarded_at AS onboardedAt, do_not_disturb AS doNotDisturb,
              plan, plan_status AS planStatus, seat_limit AS seatLimit, created_at AS createdAt, updated_at AS updatedAt,
              deleted_at AS deletedAt`;

// D1 has no native boolean type, so RETURNING/SELECT come back with
// doNotDisturb as 0/1 — normalize to a real boolean before handing out AppUser.
type AppUserRow = Omit<AppUser, "doNotDisturb"> & { doNotDisturb: number };
function normalizeAppUser(row: AppUserRow): AppUser {
  return { ...row, doNotDisturb: Boolean(row.doNotDisturb) };
}

export async function upsertUser(identity: AuthenticatedIdentity, database = getDb()): Promise<AppUser> {
  const now = Date.now();

  // Only email/updated_at refresh on repeat logins: display_name and the
  // profile fields are owned by onboarding/account-settings, not the IdP, so
  // this must never stomp what the user already set.
  //
  // Both lookups exclude deleted_at rows: deleteAccount scrubs
  // chatgpt_user_id/email to a value the IdP will never present again, so
  // this exclusion is belt-and-braces rather than the thing doing the work —
  // but it keeps a tombstone row permanently unmatchable even if that ever
  // changed, so a deleted identity always lands on a brand-new account below.
  const byProvider = await database
    .prepare(
      `UPDATE users SET email = ?, updated_at = ? WHERE chatgpt_user_id = ? AND deleted_at IS NULL RETURNING ${APP_USER_COLUMNS}`,
    )
    .bind(identity.email, now, identity.providerUserId)
    .first<AppUserRow>();
  if (byProvider) return normalizeAppUser(byProvider);

  // Cloudflare Access issues a different `sub` per login method (Google vs.
  // a one-time email code), so a returning user who signs in a different way
  // than last time presents a provider id we've never seen. Fall back to
  // matching by email — the account key since idx_users_email, and always
  // canonicalized before it reaches here (lib/identity.ts's normalizeEmail)
  // — so they land on their existing account and its session memberships
  // instead of a fresh, empty one. Before idx_users_email existed, a case
  // mismatch here silently fell through to the INSERT below and created a
  // permanent duplicate account with no memberships — the direct cause of
  // the Google-sign-in-returns-404 bug that idx_users_email and the 0022
  // merge migration fix.
  const byEmail = await database
    .prepare(
      `UPDATE users SET chatgpt_user_id = ?, updated_at = ? WHERE email = ? AND deleted_at IS NULL RETURNING ${APP_USER_COLUMNS}`,
    )
    .bind(identity.providerUserId, now, identity.email)
    .first<AppUserRow>();
  if (byEmail) return normalizeAppUser(byEmail);

  // Neither matched — a genuinely new account. ON CONFLICT(email) rather
  // than a plain INSERT closes the race between two concurrent first logins
  // for the same address via different methods (e.g. two tabs, one
  // finishing a Google login and one finishing an email-code login at the
  // same moment): the loser's insert becomes an update onto the row the
  // winner just created instead of throwing on idx_users_email.
  const createdId = crypto.randomUUID();
  const created = await database
    .prepare(
      `INSERT INTO users (id, chatgpt_user_id, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET chatgpt_user_id = excluded.chatgpt_user_id, updated_at = excluded.updated_at
       RETURNING ${APP_USER_COLUMNS}`,
    )
    .bind(createdId, identity.providerUserId, identity.email, identity.displayName, now, now)
    .first<AppUserRow>();

  if (!created) throw new Error("Unable to create or update the current user.");
  return normalizeAppUser(created);
}

export async function findUserById(userId: string, database = getDb()): Promise<AppUser | null> {
  const row = await database
    .prepare(`SELECT ${APP_USER_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<AppUserRow>();
  return row ? normalizeAppUser(row) : null;
}

export async function completeOnboarding(
  userId: string,
  input: { firstName: string; lastName: string; githubHandle: string | null; avatarKey: string | null },
  database = getDb(),
): Promise<AppUser> {
  return writeOnboardingProfile(userId, input, true, database);
}

export async function savePendingOnboardingProfile(
  userId: string,
  input: { firstName: string; lastName: string; githubHandle: string | null; avatarKey: string | null },
  database = getDb(),
): Promise<AppUser> {
  return writeOnboardingProfile(userId, input, false, database);
}

async function writeOnboardingProfile(
  userId: string,
  input: { firstName: string; lastName: string; githubHandle: string | null; avatarKey: string | null },
  complete: boolean,
  database: D1DatabaseLike,
): Promise<AppUser> {
  const now = Date.now();
  const displayName = displayNameFrom(input.firstName, input.lastName);
  const user = await database
    .prepare(
      `UPDATE users SET
         first_name = ?,
         last_name = ?,
         github_handle = ?,
         avatar_key = COALESCE(?, avatar_key),
         display_name = ?,
         onboarded_at = CASE WHEN ? THEN ? ELSE onboarded_at END,
         updated_at = ?
       WHERE id = ?
       RETURNING ${APP_USER_COLUMNS}`,
    )
    .bind(input.firstName, input.lastName, input.githubHandle, input.avatarKey, displayName, complete ? 1 : 0, now, now, userId)
    .first<AppUserRow>();
  if (!user) throw new Error("Unable to complete onboarding for the current user.");
  return normalizeAppUser(user);
}

export async function markOnboardingComplete(userId: string, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND first_name IS NOT NULL AND last_name IS NOT NULL`,
  ).bind(now, now, userId).run();
}

// Account-settings profile edit, unlike completeOnboarding above: avatarKey
// is a genuine three-state value (undefined keeps the existing picture,
// null clears it, a string sets a new R2 key) rather than completeOnboarding's
// COALESCE-only "add, never remove." Never touches onboarded_at.
export async function updateProfile(
  userId: string,
  input: { firstName: string; lastName: string; githubHandle: string | null; avatarKey: string | null | undefined },
  database = getDb(),
): Promise<AppUser> {
  const now = Date.now();
  const displayName = displayNameFrom(input.firstName, input.lastName);
  const keepAvatar = input.avatarKey === undefined;
  const user = await database
    .prepare(
      `UPDATE users SET
         first_name = ?,
         last_name = ?,
         github_handle = ?,
         avatar_key = CASE WHEN ? THEN avatar_key ELSE ? END,
         display_name = ?,
         updated_at = ?
       WHERE id = ?
       RETURNING ${APP_USER_COLUMNS}`,
    )
    .bind(input.firstName, input.lastName, input.githubHandle, keepAvatar ? 1 : 0, input.avatarKey ?? null, displayName, now, userId)
    .first<AppUserRow>();
  if (!user) throw new Error("Unable to update the current user's profile.");
  return normalizeAppUser(user);
}

export async function setDoNotDisturb(userId: string, value: boolean, database = getDb()): Promise<AppUser> {
  const now = Date.now();
  const user = await database
    .prepare(`UPDATE users SET do_not_disturb = ?, updated_at = ? WHERE id = ? RETURNING ${APP_USER_COLUMNS}`)
    .bind(value ? 1 : 0, now, userId)
    .first<AppUserRow>();
  if (!user) throw new Error("Unable to update the current user.");
  return normalizeAppUser(user);
}

export async function listSessionsForUser(userId: string, database = getDb()): Promise<SessionSummary[]> {
  const result = await database
    .prepare(
      `SELECT s.id, s.title, s.objective, mine.role,
              COUNT(all_members.user_id) AS memberCount,
              s.created_at AS createdAt, s.updated_at AS updatedAt, s.objective_updated_at AS objectiveUpdatedAt,
              s.ended_at AS endedAt, s.ended_reason AS endedReason,
              mine.archived_at AS archivedAt, s.active_seconds AS activeSeconds, s.locked_at AS lockedAt,
              s.auto_provision_agents AS autoProvisionAgents, s.auto_agent_provider AS autoAgentProvider
       FROM sessions s
       JOIN session_members mine ON mine.session_id = s.id AND mine.user_id = ? AND mine.removed_at IS NULL
       JOIN session_members all_members ON all_members.session_id = s.id AND all_members.removed_at IS NULL
       GROUP BY s.id, mine.role, mine.archived_at
       ORDER BY s.updated_at DESC`,
    )
    .bind(userId)
    .all<SessionRecord>();
  return result.results.map(normalizeSession);
}

export async function createSession(
  userId: string,
  input: { title: string; objective: string | null },
  database = getDb(),
): Promise<{ session: SessionSummary; inviteId: string }> {
  const sessionId = crypto.randomUUID();
  const inviteId = crypto.randomUUID();
  const now = Date.now();

  await database.batch([
    // auto_dispatch named explicitly as 1: the SQL column default stays
    // false (flipping db/schema.ts's .default(true) would make drizzle-kit
    // emit a sessions table recreate, which drizzle/0019 documents as
    // cascade-deleting session_members/session_invites/github_connection_states).
    // Existing sessions get the same value via migration 0027's one-time backfill.
    database
      .prepare("INSERT INTO sessions (id, title, objective, auto_dispatch, created_at, updated_at, objective_updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)")
      .bind(sessionId, input.title, input.objective, now, now, now),
    database
      .prepare("INSERT INTO session_members (session_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .bind(sessionId, userId, now),
    database
      .prepare("INSERT INTO session_invites (id, session_id, created_by, created_at) VALUES (?, ?, ?, ?)")
      .bind(inviteId, sessionId, userId, now),
  ]);

  return {
    session: {
      id: sessionId,
      title: input.title,
      objective: input.objective,
      role: "owner",
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
      objectiveUpdatedAt: now,
      endedAt: null,
      endedReason: null,
      archivedAt: null,
      activeSeconds: 0,
      lockedAt: null,
      autoProvisionAgents: true,
      autoAgentProvider: null,
    },
    inviteId,
  };
}

export async function createSessionWithRepository(
  userId: string,
  input: { title: string; objective: string | null },
  repository: {
    installationId: string;
    id: string;
    nodeId: string;
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
  },
  candidate: { id: string; branchName: string; baseSha: string },
  sessionId: string,
  database = getDb(),
): Promise<{ session: SessionSummary; inviteId: string; connectionId: string }> {
  const inviteId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const now = Date.now();
  await database.batch([
    database.prepare(
      "INSERT INTO sessions (id, title, objective, auto_dispatch, created_at, updated_at, objective_updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
    ).bind(sessionId, input.title, input.objective, now, now, now),
    database.prepare("INSERT INTO session_members (session_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
      .bind(sessionId, userId, now),
    database.prepare("INSERT INTO session_invites (id, session_id, created_by, created_at) VALUES (?, ?, ?, ?)")
      .bind(inviteId, sessionId, userId, now),
    database.prepare(
      `INSERT INTO repository_connections
       (id, session_id, installation_id, repository_id, repository_node_id, repository_owner,
        repository_name, repository_full_name, repository_private, default_branch, base_branch,
        status, connected_by, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?)`,
    ).bind(connectionId, sessionId, repository.installationId, repository.id, repository.nodeId, repository.owner,
      repository.name, repository.fullName, repository.private ? 1 : 0, repository.defaultBranch,
      repository.defaultBranch, userId, now, now),
    database.prepare(
      `INSERT INTO repository_candidates
       (id, session_id, connection_id, name, description, branch_name, base_branch, base_sha,
        status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`,
    ).bind(candidate.id, sessionId, connectionId, input.title, input.objective ?? "", candidate.branchName,
      repository.defaultBranch, candidate.baseSha, userId, now, now),
  ]);
  return {
    session: {
      id: sessionId, title: input.title, objective: input.objective, role: "owner", memberCount: 1,
      createdAt: now, updatedAt: now, objectiveUpdatedAt: now, endedAt: null, endedReason: null,
      archivedAt: null, activeSeconds: 0, lockedAt: null, autoProvisionAgents: true, autoAgentProvider: null,
    },
    inviteId,
    connectionId,
  };
}

export async function getSessionForMember(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<SessionSummary | null> {
  const record = await database
    .prepare(
      `SELECT s.id, s.title, s.objective, mine.role,
              COUNT(all_members.user_id) AS memberCount,
              s.created_at AS createdAt, s.updated_at AS updatedAt, s.objective_updated_at AS objectiveUpdatedAt,
              s.ended_at AS endedAt, s.ended_reason AS endedReason,
              mine.archived_at AS archivedAt, s.active_seconds AS activeSeconds, s.locked_at AS lockedAt,
              s.auto_provision_agents AS autoProvisionAgents, s.auto_agent_provider AS autoAgentProvider
       FROM sessions s
       JOIN session_members mine ON mine.session_id = s.id AND mine.user_id = ? AND mine.removed_at IS NULL
       JOIN session_members all_members ON all_members.session_id = s.id AND all_members.removed_at IS NULL
       WHERE s.id = ?
       GROUP BY s.id, mine.role, mine.archived_at`,
    )
    .bind(userId, sessionId)
    .first<SessionRecord>();
  return record ? normalizeSession(record) : null;
}

export async function archiveSessionForMember(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<"archived" | "missing"> {
  const result = await database
    .prepare("UPDATE session_members SET archived_at = ? WHERE session_id = ? AND user_id = ?")
    .bind(Date.now(), sessionId, userId)
    .run();
  return Number(result.meta?.changes ?? 0) > 0 ? "archived" : "missing";
}

export async function unarchiveSessionForMember(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<"unarchived" | "missing"> {
  const result = await database
    .prepare("UPDATE session_members SET archived_at = NULL WHERE session_id = ? AND user_id = ?")
    .bind(sessionId, userId)
    .run();
  return Number(result.meta?.changes ?? 0) > 0 ? "unarchived" : "missing";
}

export async function updateSessionObjective(
  sessionId: string,
  userId: string,
  objective: string | null,
  database = getDb(),
): Promise<SessionSummary | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  const now = Date.now();
  const result = await database
    .prepare("UPDATE sessions SET objective = ?, updated_at = ?, objective_updated_at = ? WHERE id = ? AND ended_at IS NULL")
    .bind(objective, now, now, sessionId)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  }
  return getSessionForMember(sessionId, userId, database);
}

export async function getSessionMembers(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<SessionMember[] | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const result = await database
    .prepare(
      `SELECT u.id, u.display_name AS displayName, sm.role, sm.joined_at AS joinedAt
       FROM session_members sm
       JOIN users u ON u.id = sm.user_id
       WHERE sm.session_id = ? AND sm.removed_at IS NULL
       ORDER BY CASE sm.role WHEN 'owner' THEN 0 ELSE 1 END, lower(u.display_name), sm.joined_at`,
    )
    .bind(sessionId)
    .all<Omit<SessionMember, "online">>();
  return result.results.map((member) => ({ ...member, online: false }));
}

// Owner-only audit view of who has been removed, so the soft delete this
// backs (acceptInvite blocks these rows; restoreMember clears them) is
// visible in the product rather than only in D1.
export async function getRemovedSessionMembers(
  sessionId: string,
  ownerId: string,
  database = getDb(),
): Promise<RemovedSessionMember[] | null> {
  if ((await getMembershipRole(sessionId, ownerId, database)) !== "owner") return null;
  const result = await database
    .prepare(
      `SELECT u.id, u.display_name AS displayName, sm.removed_at AS removedAt
       FROM session_members sm
       JOIN users u ON u.id = sm.user_id
       WHERE sm.session_id = ? AND sm.removed_at IS NOT NULL
       ORDER BY sm.removed_at DESC`,
    )
    .bind(sessionId)
    .all<RemovedSessionMember>();
  return result.results;
}

export async function getMembershipRole(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<SessionRole | null> {
  const row = await database
    .prepare("SELECT role FROM session_members WHERE session_id = ? AND user_id = ? AND removed_at IS NULL")
    .bind(sessionId, userId)
    .first<{ role: SessionRole }>();
  return row?.role ?? null;
}

/* The write guard. Every mutation on session-scoped data authorizes through
   this instead of getMembershipRole so ended sessions reject writes in one
   place; reads keep using getMembershipRole so ended sessions stay viewable.
   Non-members still resolve to null first (404 concealment) — the ended check
   only fires for actual members. */
export async function getActiveMembershipRole(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<SessionRole | null> {
  const row = await database
    .prepare(
      `SELECT sm.role, s.ended_at AS endedAt
       FROM session_members sm
       JOIN sessions s ON s.id = sm.session_id
       WHERE sm.session_id = ? AND sm.user_id = ? AND sm.removed_at IS NULL`,
    )
    .bind(sessionId, userId)
    .first<{ role: SessionRole; endedAt: number | null }>();
  if (!row) return null;
  if (row.endedAt != null) throw new SessionEndedError();
  return row.role;
}

export async function endSession(
  sessionId: string,
  userId: string,
  reason: "owner" | "merged" = "owner",
  database = getDb(),
): Promise<"missing" | "forbidden" | { blocked: "integration_in_progress"; runId: string } | { endedAt: number; reason: "owner" | "merged" }> {
  // Deliberately getMembershipRole, not the active guard: ending must work
  // regardless of (and idempotently after) the ended state.
  const role = await getMembershipRole(sessionId, userId, database);
  if (!role) return "missing";
  if (role !== "owner") return "forbidden";
  const blocking = await getBlockingIntegrationRunId(sessionId, database);
  if (blocking) return { blocked: "integration_in_progress", runId: blocking };
  const now = Date.now();
  await database.batch([
    database
      .prepare("UPDATE sessions SET ended_at = ?, ended_reason = ?, updated_at = ? WHERE id = ? AND ended_at IS NULL")
      .bind(now, reason, now, sessionId),
    database
      .prepare("UPDATE session_invites SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL")
      .bind(now, sessionId),
  ]);
  const row = await database
    .prepare("SELECT ended_at AS endedAt, ended_reason AS endedReason FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ endedAt: number; endedReason: "owner" | "merged" | null }>();
  return { endedAt: row?.endedAt ?? now, reason: row?.endedReason ?? reason };
}

/* A candidate mid-integration is actively pushing/merging into its branch —
   merge, end, and delete all refuse to run concurrently with that and instead
   surface the blocking run so the owner can cancel it and retry. */
async function getBlockingIntegrationRunId(sessionId: string, database: D1DatabaseLike): Promise<string | null> {
  const row = await database
    .prepare("SELECT integration_run_id AS integrationRunId FROM repository_candidates WHERE session_id = ? AND integration_run_id IS NOT NULL")
    .bind(sessionId)
    .first<{ integrationRunId: string }>();
  return row?.integrationRunId ?? null;
}

export async function getInvitePreview(inviteId: string, database = getDb()): Promise<InvitePreview | null> {
  const row = await database
    .prepare(
      `SELECT i.id AS inviteId, s.id AS sessionId, s.title, s.objective, s.locked_at AS lockedAt,
              owner.display_name AS ownerName, owner.plan AS ownerPlan, owner.plan_status AS ownerPlanStatus,
              owner.seat_limit AS ownerSeatLimit, owner.email AS ownerEmail,
              (SELECT COUNT(*) FROM session_members m WHERE m.session_id = s.id AND m.removed_at IS NULL) AS memberCount
       FROM session_invites i
       JOIN sessions s ON s.id = i.session_id
       JOIN session_members owner_member ON owner_member.session_id = s.id AND owner_member.role = 'owner' AND owner_member.removed_at IS NULL
       JOIN users owner ON owner.id = owner_member.user_id
       WHERE i.id = ? AND i.revoked_at IS NULL`,
    )
    .bind(inviteId)
    .first<{
      inviteId: string; sessionId: string; title: string; objective: string | null; lockedAt: number | null; ownerName: string;
      ownerPlan: Plan; ownerPlanStatus: PlanStatus; ownerSeatLimit: number | null; ownerEmail: string; memberCount: number;
    }>();
  if (!row) return null;
  const { ownerPlan, ownerPlanStatus, ownerSeatLimit, ownerEmail, lockedAt, ...preview } = row;
  return { ...preview, seatLimit: effectiveSeatLimit(ownerPlan, ownerPlanStatus, ownerSeatLimit, ownerEmail), locked: lockedAt != null };
}

export async function acceptInvite(
  inviteId: string,
  userId: string,
  database = getDb(),
): Promise<string | "full" | "removed" | "locked" | null> {
  const gate = await database
    .prepare(
      `SELECT (SELECT COUNT(*) FROM session_members m WHERE m.session_id = i.session_id AND m.removed_at IS NULL) AS memberCount,
              (SELECT u.plan FROM session_members o JOIN users u ON u.id = o.user_id
                 WHERE o.session_id = i.session_id AND o.role = 'owner' AND o.removed_at IS NULL) AS ownerPlan,
              (SELECT u.plan_status FROM session_members o JOIN users u ON u.id = o.user_id
                 WHERE o.session_id = i.session_id AND o.role = 'owner' AND o.removed_at IS NULL) AS ownerPlanStatus,
              (SELECT u.seat_limit FROM session_members o JOIN users u ON u.id = o.user_id
                 WHERE o.session_id = i.session_id AND o.role = 'owner' AND o.removed_at IS NULL) AS ownerSeatLimit,
              (SELECT u.email FROM session_members o JOIN users u ON u.id = o.user_id
                 WHERE o.session_id = i.session_id AND o.role = 'owner' AND o.removed_at IS NULL) AS ownerEmail,
              EXISTS(SELECT 1 FROM session_members m
                 WHERE m.session_id = i.session_id AND m.user_id = ?1) AS callerExists,
              (SELECT m.removed_at FROM session_members m
                 WHERE m.session_id = i.session_id AND m.user_id = ?1) AS callerRemovedAt,
              s.locked_at AS lockedAt
       FROM session_invites i
       JOIN sessions s ON s.id = i.session_id
       WHERE i.id = ?2 AND i.revoked_at IS NULL`,
    )
    .bind(userId, inviteId)
    .first<{
      memberCount: number; ownerPlan: Plan | null; ownerPlanStatus: PlanStatus | null; ownerSeatLimit: number | null;
      ownerEmail: string | null; callerExists: number; callerRemovedAt: number | null; lockedAt: number | null;
    }>();
  if (!gate) return null;
  // A removed row still exists, so callerExists is true for it — check the
  // block before deriving alreadyMember below, or a removed caller would
  // read as a brand-new joiner instead of being refused.
  if (gate.callerExists && gate.callerRemovedAt != null) return "removed";
  const alreadyMember = Boolean(gate.callerExists);
  // Lock gates new joins only; an existing member's idempotent re-accept
  // (e.g. after a reload) must keep working while locked.
  if (!alreadyMember && gate.lockedAt != null) return "locked";
  // Missing owner plan/status shouldn't happen (every session has an active
  // owner row), but if it ever does, resolve to the strictest limits rather
  // than the old "pro" fallback.
  const plan = gate.ownerPlan ?? "free";
  const status = gate.ownerPlanStatus ?? "inactive";
  // ponytail: check-then-insert; concurrent accepts can exceed the cap by the
  // number of racers. Upgrade path if it matters: conditional INSERT...SELECT
  // guarded by the count inside the batch.
  if (!alreadyMember && gate.memberCount >= effectiveSeatLimit(plan, status, gate.ownerSeatLimit, gate.ownerEmail)) {
    return "full";
  }

  const now = Date.now();
  await database.batch([
    database.prepare(
      `INSERT INTO session_members (session_id, user_id, role, joined_at)
       SELECT session_id, ?, 'member', ? FROM session_invites
       WHERE id = ? AND revoked_at IS NULL
       ON CONFLICT(session_id, user_id) DO NOTHING`,
    ).bind(userId, now, inviteId),
    database.prepare(
      `UPDATE sessions SET updated_at = ?
       WHERE id = (SELECT session_id FROM session_invites WHERE id = ? AND revoked_at IS NULL)`,
    ).bind(now, inviteId),
  ]);

  const membership = await database
    .prepare(
      `SELECT sm.session_id AS sessionId
       FROM session_members sm
       JOIN session_invites i ON i.session_id = sm.session_id
       WHERE i.id = ? AND i.revoked_at IS NULL AND sm.user_id = ? AND sm.removed_at IS NULL`,
    )
    .bind(inviteId, userId)
    .first<{ sessionId: string }>();

  return membership?.sessionId ?? null;
}

export async function getActiveInviteId(
  sessionId: string,
  ownerId: string,
  database = getDb(),
): Promise<string | null> {
  if ((await getMembershipRole(sessionId, ownerId, database)) !== "owner") return null;
  const invite = await database
    .prepare("SELECT id FROM session_invites WHERE session_id = ? AND revoked_at IS NULL")
    .bind(sessionId)
    .first<{ id: string }>();
  return invite?.id ?? null;
}

export async function rotateInvite(
  sessionId: string,
  ownerId: string,
  database = getDb(),
): Promise<string | null> {
  if ((await getActiveMembershipRole(sessionId, ownerId, database)) !== "owner") return null;
  const inviteId = crypto.randomUUID();
  const now = Date.now();
  await database.batch([
    database
      .prepare("UPDATE session_invites SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL")
      .bind(now, sessionId),
    database
      .prepare("INSERT INTO session_invites (id, session_id, created_by, created_at) VALUES (?, ?, ?, ?)")
      .bind(inviteId, sessionId, ownerId, now),
  ]);
  return inviteId;
}

export async function revokeInvite(
  sessionId: string,
  ownerId: string,
  database = getDb(),
): Promise<boolean> {
  if ((await getActiveMembershipRole(sessionId, ownerId, database)) !== "owner") return false;
  await database
    .prepare("UPDATE session_invites SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), sessionId)
    .run();
  return true;
}

export async function setSessionRoutingSettings(
  sessionId: string,
  ownerId: string,
  input: { autoDispatch?: boolean; autoProvisionAgents?: boolean; autoAgentProvider?: CredentialProvider | null; autoResolveConflicts?: boolean },
  database = getDb(),
): Promise<boolean> {
  if ((await getActiveMembershipRole(sessionId, ownerId, database)) !== "owner") return false;
  if (input.autoAgentProvider) {
    const credential = await database.prepare(
      "SELECT 1 AS present FROM user_provider_credentials WHERE user_id = ? AND provider = ?",
    ).bind(ownerId, input.autoAgentProvider).first<{ present: number }>();
    if (!credential) throw new SessionRoutingError("Connect that provider key before selecting it for generated agents.");
  }
  const result = await database.prepare(
    `UPDATE sessions SET
       auto_dispatch = COALESCE(?, auto_dispatch),
       auto_provision_agents = COALESCE(?, auto_provision_agents),
       auto_agent_provider = CASE WHEN ? = 1 THEN ? ELSE auto_agent_provider END,
       auto_resolve_conflicts = COALESCE(?, auto_resolve_conflicts),
       floor_revision = floor_revision + 1, updated_at = ?
     WHERE id = ? AND ended_at IS NULL`,
  ).bind(
    input.autoDispatch === undefined ? null : input.autoDispatch ? 1 : 0,
    input.autoProvisionAgents === undefined ? null : input.autoProvisionAgents ? 1 : 0,
    input.autoAgentProvider === undefined ? 0 : 1,
    input.autoAgentProvider ?? null,
    input.autoResolveConflicts === undefined ? null : input.autoResolveConflicts ? 1 : 0,
    Date.now(), sessionId,
  ).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

/** Compatibility helper for callers that only change ordinary auto-dispatch. */
export function setSessionAutoDispatch(sessionId: string, ownerId: string, enabled: boolean, database = getDb()) {
  return setSessionRoutingSettings(sessionId, ownerId, { autoDispatch: enabled }, database);
}

export async function leaveSession(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<"left" | "owner" | "missing"> {
  const role = await getMembershipRole(sessionId, userId, database);
  if (!role) return "missing";
  if (role === "owner") return "owner";
  const now = Date.now();
  await database.batch([
    database.prepare("DELETE FROM floor_assignments WHERE session_id = ? AND user_id = ?").bind(sessionId, userId),
    // Keeps floor_agents.owner_user_id pointed at a real member: without
    // this, a leaving agent owner strands the create-time invariant
    // (db/floor.ts's createFloorAgent requires the owner be a member) and
    // the snapshot still renders the agent because it joins users, not
    // session_members.
    database
      .prepare(
        `UPDATE floor_agents SET owner_user_id = (
           SELECT user_id FROM session_members WHERE session_id = ? AND role = 'owner' AND removed_at IS NULL
         ), updated_at = ?
         WHERE session_id = ? AND owner_user_id = ?`,
      )
      .bind(sessionId, now, sessionId, userId),
    database.prepare("DELETE FROM session_members WHERE session_id = ? AND user_id = ?").bind(sessionId, userId),
    database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return "left";
}

// Soft delete: the row is kept (removed_at/removed_by set) rather than
// deleted, so acceptInvite can refuse the same person on the still-valid
// invite link and the owner has an audit trail to restore from. Authorizes
// through getActiveMembershipRole (not the plain read guard) because an
// ended session is already read-only for everyone — there is nothing left
// to evict a member from.
export async function removeMember(
  sessionId: string,
  ownerId: string,
  targetUserId: string,
  database = getDb(),
): Promise<"missing" | "forbidden" | "self" | "owner_target" | { removedAt: number; revision: number }> {
  const role = await getActiveMembershipRole(sessionId, ownerId, database);
  if (!role) return "missing";
  if (role !== "owner") return "forbidden";
  if (targetUserId === ownerId) return "self";
  const target = await database
    .prepare("SELECT role FROM session_members WHERE session_id = ? AND user_id = ? AND removed_at IS NULL")
    .bind(sessionId, targetUserId)
    .first<{ role: SessionRole }>();
  if (!target) return "missing";
  if (target.role === "owner") return "owner_target";

  const now = Date.now();
  await database.batch([
    database
      .prepare("UPDATE session_members SET removed_at = ?, removed_by = ? WHERE session_id = ? AND user_id = ? AND removed_at IS NULL")
      .bind(now, ownerId, sessionId, targetUserId),
    database.prepare("DELETE FROM floor_assignments WHERE session_id = ? AND user_id = ?").bind(sessionId, targetUserId),
    // Their content (chat, queue prompts) stays as session history; only the
    // agents they owned transfer, to the owner doing the removing.
    database
      .prepare("UPDATE floor_agents SET owner_user_id = ?, updated_at = ? WHERE session_id = ? AND owner_user_id = ?")
      .bind(ownerId, now, sessionId, targetUserId),
    database
      .prepare("UPDATE sessions SET updated_at = ?, floor_revision = floor_revision + 1 WHERE id = ?")
      .bind(now, sessionId),
  ]);
  const revision = await database
    .prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ revision: number }>();
  return { removedAt: now, revision: Number(revision?.revision ?? 0) };
}

// Re-runs the seat cap (not just idempotently clearing removed_at) because a
// restore is functionally a fresh join — skipping this would let an owner
// walk straight through their own plan's seat limit.
export async function restoreMember(
  sessionId: string,
  ownerId: string,
  targetUserId: string,
  database = getDb(),
): Promise<"missing" | "forbidden" | "full" | { restoredAt: number }> {
  const role = await getActiveMembershipRole(sessionId, ownerId, database);
  if (!role) return "missing";
  if (role !== "owner") return "forbidden";
  const target = await database
    .prepare("SELECT removed_at AS removedAt FROM session_members WHERE session_id = ? AND user_id = ?")
    .bind(sessionId, targetUserId)
    .first<{ removedAt: number | null }>();
  if (!target || target.removedAt == null) return "missing";

  const owner = await database
    .prepare(
      `SELECT u.plan AS plan, u.plan_status AS planStatus, u.seat_limit AS seatLimit, u.email AS email,
              (SELECT COUNT(*) FROM session_members m WHERE m.session_id = ? AND m.removed_at IS NULL) AS memberCount
       FROM session_members o JOIN users u ON u.id = o.user_id
       WHERE o.session_id = ? AND o.role = 'owner' AND o.removed_at IS NULL`,
    )
    .bind(sessionId, sessionId)
    .first<{ plan: Plan; planStatus: PlanStatus; seatLimit: number | null; email: string | null; memberCount: number }>();
  const seatLimit = effectiveSeatLimit(owner?.plan ?? "free", owner?.planStatus ?? "inactive", owner?.seatLimit ?? null, owner?.email);
  if ((owner?.memberCount ?? 0) >= seatLimit) return "full";

  const now = Date.now();
  await database
    .prepare("UPDATE session_members SET removed_at = NULL, removed_by = NULL WHERE session_id = ? AND user_id = ?")
    .bind(sessionId, targetUserId)
    .run();
  return { restoredAt: now };
}

// Reversible door-seal: acceptInvite refuses new joins while locked, but
// existing members keep full read/write and stay connected. Distinct from
// endSession, which is terminal and read-only for everyone.
export async function setSessionLocked(
  sessionId: string,
  ownerId: string,
  locked: boolean,
  database = getDb(),
): Promise<{ lockedAt: number | null } | false> {
  if ((await getActiveMembershipRole(sessionId, ownerId, database)) !== "owner") return false;
  const now = Date.now();
  const lockedAt = locked ? now : null;
  await database
    .prepare("UPDATE sessions SET locked_at = ?, updated_at = ? WHERE id = ? AND ended_at IS NULL")
    .bind(lockedAt, now, sessionId)
    .run();
  return { lockedAt };
}

export const ENDED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function purgeExpiredSessions(database = getDb(), now = Date.now()): Promise<string[]> {
  // Every session-scoped child cascades on sessions.id, so one statement
  // clears an eligible graph. Repository connections fail closed because
  // their D1 records hold the leases needed for future external cleanup.
  // ponytail: unbatched DELETE — add a LIMIT loop only if row counts demand it.
  const result = await database
    .prepare(
      `DELETE FROM sessions
       WHERE ended_at IS NOT NULL AND ended_at < ?
         AND NOT EXISTS (SELECT 1 FROM repository_connections WHERE session_id = sessions.id)
       RETURNING id`,
    )
    .bind(now - ENDED_SESSION_RETENTION_MS)
    .all<{ id: string }>();
  return result.results.map((row) => row.id);
}

export async function deleteSession(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<"forbidden" | "missing" | "repository_state" | { blocked: "integration_in_progress"; runId: string } | { deleted: true; candidateBranchAlive: boolean }> {
  // Plain guard on purpose: deleting must work on ended sessions too.
  const role = await getMembershipRole(sessionId, userId, database);
  if (!role) return "missing";
  if (role !== "owner") return "forbidden";
  const blocking = await getBlockingIntegrationRunId(sessionId, database);
  if (blocking) return { blocked: "integration_in_progress", runId: blocking };
  // A session results in at most one candidate branch; only an unmerged one
  // (still creating/active) represents live work that would be lost. A
  // merged candidate — its branch deleted or not — never blocks deletion.
  const liveCandidate = await database
    .prepare("SELECT 1 AS present FROM repository_candidates WHERE session_id = ? AND status IN ('creating', 'active') AND merged_at IS NULL")
    .bind(sessionId)
    .first<{ present: number }>();
  if (liveCandidate) return "repository_state";
  const survivingBranch = await database
    .prepare("SELECT 1 AS present FROM repository_candidates WHERE session_id = ? AND merged_at IS NOT NULL AND branch_deleted_at IS NULL")
    .bind(sessionId)
    .first<{ present: number }>();
  const result = await database.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  if (Number(result.meta?.changes ?? 0) === 0) return "missing";
  return { deleted: true, candidateBranchAlive: Boolean(survivingBranch) };
}

export type DeleteAccountBlockedSession = { id: string; title: string; reason: "repository_state" | "integration_in_progress" };

export async function getAccountDeletionBlockers(
  userId: string,
  database = getDb(),
): Promise<{ ownedSessionIds: string[]; blocked: DeleteAccountBlockedSession[] }> {
  const owned = await database
    .prepare(
      `SELECT s.id AS id, s.title AS title
       FROM session_members sm JOIN sessions s ON s.id = sm.session_id
       WHERE sm.user_id = ? AND sm.role = 'owner'`,
    )
    .bind(userId)
    .all<{ id: string; title: string }>();
  const blocked: DeleteAccountBlockedSession[] = [];
  for (const session of owned.results) {
    const blocking = await getBlockingIntegrationRunId(session.id, database);
    if (blocking) {
      blocked.push({ id: session.id, title: session.title, reason: "integration_in_progress" });
      continue;
    }
    const liveCandidate = await database
      .prepare("SELECT 1 AS present FROM repository_candidates WHERE session_id = ? AND status IN ('creating', 'active') AND merged_at IS NULL")
      .bind(session.id)
      .first<{ present: number }>();
    if (liveCandidate) blocked.push({ id: session.id, title: session.title, reason: "repository_state" });
  }
  return { ownedSessionIds: owned.results.map((session) => session.id), blocked };
}

/* Account deletion cannot be a hard `DELETE FROM users`: ~12 columns
   (floor_messages.author_user_id, floor_agents.owner_user_id,
   repository_candidates.merged_by, ...) reference users.id with no cascade,
   and the users-must-never-be-recreated invariant (see the plan/planStatus
   comment on the table above) rules out an FK migration to add one. Instead
   this scrubs the identifying fields and releases chatgpt_user_id/email so a
   future sign-in with the same provider identity creates a fresh row
   (upsertUser's two lookups both exclude deleted_at rows) — every FK that
   pointed at this row keeps pointing at a valid, if anonymized, one.
   usage_months is deliberately never touched here; see its no-FK comment. */
export async function deleteAccount(
  userId: string,
  database = getDb(),
): Promise<{ deleted: true } | { blocked: "sessions"; sessions: DeleteAccountBlockedSession[] }> {
  // Same guards as deleteSession, run per owned session, before anything is
  // written — a live repository candidate or in-progress integration on any
  // one owned session blocks the entire account deletion rather than
  // silently losing that work.
  const { ownedSessionIds, blocked } = await getAccountDeletionBlockers(userId, database);
  if (blocked.length > 0) return { blocked: "sessions", sessions: blocked };

  const now = Date.now();
  await database.batch([
    ...ownedSessionIds.map((sessionId) => database.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId)),
    // Memberships (and assignments) in sessions this user did not own —
    // session_members would cascade on its own, but floor_assignments has no
    // FK action, same reason leaveSession deletes it explicitly.
    database.prepare("DELETE FROM floor_assignments WHERE user_id = ?").bind(userId),
    database.prepare("DELETE FROM session_members WHERE user_id = ?").bind(userId),
    // Encrypted provider credentials: the users row is scrubbed below, not
    // deleted, so the FK cascade never fires — delete them explicitly.
    database.prepare("DELETE FROM user_provider_credentials WHERE user_id = ?").bind(userId),
    database.prepare("DELETE FROM github_account_connection_states WHERE user_id = ?").bind(userId),
    database.prepare("DELETE FROM user_github_installations WHERE user_id = ?").bind(userId),
    database
      .prepare(
        `UPDATE users SET
           chatgpt_user_id = 'deleted:' || id,
           email = 'deleted+' || id || '@invalid',
           display_name = 'Deleted user',
           first_name = NULL,
           last_name = NULL,
           github_handle = NULL,
           avatar_key = NULL,
           do_not_disturb = 0,
           plan_status = 'canceled',
           seat_limit = NULL,
           deleted_at = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(now, now, userId),
  ]);
  return { deleted: true };
}

export async function authorizePresence(
  sessionId: string,
  providerUserId: string,
  database: D1DatabaseLike,
): Promise<{ userId: string; displayName: string } | null> {
  return database
    .prepare(
      `SELECT u.id AS userId, u.display_name AS displayName
       FROM users u
       JOIN session_members sm ON sm.user_id = u.id
       WHERE u.chatgpt_user_id = ? AND sm.session_id = ? AND sm.removed_at IS NULL`,
    )
    .bind(providerUserId, sessionId)
    .first<{ userId: string; displayName: string }>();
}

/* Hour-quota data for the presence gate: who owns the session, their
   *effective* plan (cancelled/past-due resolves to free — the caller indexes
   PLAN_LIMITS by this directly, so returning the raw purchased plan would
   hand a lapsed Max owner 100h), and the seconds already booked to them this
   month. Ended sessions are neither gated nor metered — they stay viewable
   for free. Returns null only if the session has no owner row, which should
   never happen for a session authorizePresence already confirmed exists —
   callers should fail closed on null, not treat it as "ungated". */
export async function getOwnerHourQuota(
  sessionId: string,
  database = getDb(),
): Promise<{ ownerId: string; plan: Plan; seconds: number; endedAt: number | null } | null> {
  const row = await database
    .prepare(
      `SELECT o.user_id AS ownerId, u.plan AS plan, u.plan_status AS planStatus, u.email AS email,
              COALESCE(um.seconds, 0) AS seconds, s.ended_at AS endedAt
       FROM session_members o
       JOIN sessions s ON s.id = o.session_id
       JOIN users u ON u.id = o.user_id
       LEFT JOIN usage_months um ON um.owner_user_id = o.user_id AND um.month = ?
       WHERE o.session_id = ? AND o.role = 'owner' AND o.removed_at IS NULL`,
    )
    .bind(currentMonth(), sessionId)
    .first<{ ownerId: string; plan: Plan; planStatus: PlanStatus; email: string | null; seconds: number; endedAt: number | null }>();
  if (!row) return null;
  return { ownerId: row.ownerId, plan: effectivePlan(row.plan, row.planStatus, row.email), seconds: row.seconds, endedAt: row.endedAt };
}

export async function getUsageForUser(
  userId: string,
  database = getDb(),
): Promise<{
  plan: Plan;
  planStatus: PlanStatus;
  effectivePlan: Plan;
  seconds: number;
  limitHours: number;
  limitSeats: number;
}> {
  const row = await database
    .prepare(
      `SELECT u.plan AS plan, u.plan_status AS planStatus, u.seat_limit AS seatLimit, u.email AS email, COALESCE(um.seconds, 0) AS seconds
       FROM users u
       LEFT JOIN usage_months um ON um.owner_user_id = u.id AND um.month = ?
       WHERE u.id = ?`,
    )
    .bind(currentMonth(), userId)
    .first<{ plan: Plan; planStatus: PlanStatus; seatLimit: number | null; email: string | null; seconds: number }>();
  const plan = row?.plan ?? "free";
  const planStatus = row?.planStatus ?? "inactive";
  const effective = effectivePlan(plan, planStatus, row?.email);
  return {
    plan,
    planStatus,
    effectivePlan: effective,
    seconds: row?.seconds ?? 0,
    limitHours: PLAN_LIMITS[effective].hours,
    limitSeats: effectiveSeatLimit(plan, planStatus, row?.seatLimit ?? null, row?.email),
  };
}

export async function hourQuotaExhausted(userId: string, database = getDb()): Promise<boolean> {
  const usage = await getUsageForUser(userId, database);
  return usage.seconds >= usage.limitHours * 3600;
}

function normalizeSession(record: SessionRecord): SessionSummary {
  return { ...record, memberCount: Number(record.memberCount), autoProvisionAgents: Boolean(record.autoProvisionAgents) };
}

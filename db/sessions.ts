import { displayNameFrom } from "@/lib/display-name";
import type { AuthenticatedIdentity } from "@/lib/identity";
import { currentMonth, effectivePlan, PLAN_LIMITS, type Plan, type PlanStatus } from "@/lib/plans";
import type { AppUser, SessionMember, SessionRole, SessionSummary } from "@/lib/session-types";
import { getDb, type D1DatabaseLike } from "./index";

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
};

export class SessionEndedError extends Error {
  constructor() {
    super("This session has ended.");
  }
}

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
};

const APP_USER_COLUMNS = `id, chatgpt_user_id AS providerUserId, email, display_name AS displayName,
              first_name AS firstName, last_name AS lastName, github_handle AS githubHandle,
              avatar_key AS avatarKey, onboarded_at AS onboardedAt, do_not_disturb AS doNotDisturb,
              plan, plan_status AS planStatus, created_at AS createdAt, updated_at AS updatedAt,
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
  // matching by email so they land on their existing account (and its
  // session memberships) instead of a fresh, empty one.
  const byEmail = await database
    .prepare(
      `UPDATE users SET chatgpt_user_id = ?, updated_at = ? WHERE email = ? AND deleted_at IS NULL RETURNING ${APP_USER_COLUMNS}`,
    )
    .bind(identity.providerUserId, now, identity.email)
    .first<AppUserRow>();
  if (byEmail) return normalizeAppUser(byEmail);

  const createdId = crypto.randomUUID();
  const created = await database
    .prepare(
      `INSERT INTO users (id, chatgpt_user_id, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${APP_USER_COLUMNS}`,
    )
    .bind(createdId, identity.providerUserId, identity.email, identity.displayName, now, now)
    .first<AppUserRow>();

  if (!created) throw new Error("Unable to create or update the current user.");
  return normalizeAppUser(created);
}

export async function findUserByProviderId(
  providerUserId: string,
  database = getDb(),
): Promise<AppUser | null> {
  const row = await database
    .prepare(`SELECT ${APP_USER_COLUMNS} FROM users WHERE chatgpt_user_id = ?`)
    .bind(providerUserId)
    .first<AppUserRow>();
  return row ? normalizeAppUser(row) : null;
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
         onboarded_at = ?,
         updated_at = ?
       WHERE id = ?
       RETURNING ${APP_USER_COLUMNS}`,
    )
    .bind(input.firstName, input.lastName, input.githubHandle, input.avatarKey, displayName, now, now, userId)
    .first<AppUserRow>();
  if (!user) throw new Error("Unable to complete onboarding for the current user.");
  return normalizeAppUser(user);
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
              mine.archived_at AS archivedAt, s.active_seconds AS activeSeconds
       FROM sessions s
       JOIN session_members mine ON mine.session_id = s.id AND mine.user_id = ?
       JOIN session_members all_members ON all_members.session_id = s.id
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
    database
      .prepare("INSERT INTO sessions (id, title, objective, created_at, updated_at, objective_updated_at) VALUES (?, ?, ?, ?, ?, ?)")
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
    },
    inviteId,
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
              mine.archived_at AS archivedAt, s.active_seconds AS activeSeconds
       FROM sessions s
       JOIN session_members mine ON mine.session_id = s.id AND mine.user_id = ?
       JOIN session_members all_members ON all_members.session_id = s.id
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
       WHERE sm.session_id = ?
       ORDER BY CASE sm.role WHEN 'owner' THEN 0 ELSE 1 END, lower(u.display_name), sm.joined_at`,
    )
    .bind(sessionId)
    .all<Omit<SessionMember, "online">>();
  return result.results.map((member) => ({ ...member, online: false }));
}

export async function getMembershipRole(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<SessionRole | null> {
  const row = await database
    .prepare("SELECT role FROM session_members WHERE session_id = ? AND user_id = ?")
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
       WHERE sm.session_id = ? AND sm.user_id = ?`,
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
      `SELECT i.id AS inviteId, s.id AS sessionId, s.title, s.objective,
              owner.display_name AS ownerName, owner.plan AS ownerPlan, owner.plan_status AS ownerPlanStatus,
              (SELECT COUNT(*) FROM session_members m WHERE m.session_id = s.id) AS memberCount
       FROM session_invites i
       JOIN sessions s ON s.id = i.session_id
       JOIN session_members owner_member ON owner_member.session_id = s.id AND owner_member.role = 'owner'
       JOIN users owner ON owner.id = owner_member.user_id
       WHERE i.id = ? AND i.revoked_at IS NULL`,
    )
    .bind(inviteId)
    .first<{
      inviteId: string; sessionId: string; title: string; objective: string | null; ownerName: string;
      ownerPlan: Plan; ownerPlanStatus: PlanStatus; memberCount: number;
    }>();
  if (!row) return null;
  const { ownerPlan, ownerPlanStatus, ...preview } = row;
  return { ...preview, seatLimit: PLAN_LIMITS[effectivePlan(ownerPlan, ownerPlanStatus)].seats };
}

export async function acceptInvite(
  inviteId: string,
  userId: string,
  database = getDb(),
): Promise<string | "full" | null> {
  const gate = await database
    .prepare(
      `SELECT (SELECT COUNT(*) FROM session_members m WHERE m.session_id = i.session_id) AS memberCount,
              (SELECT u.plan FROM session_members o JOIN users u ON u.id = o.user_id
                 WHERE o.session_id = i.session_id AND o.role = 'owner') AS ownerPlan,
              (SELECT u.plan_status FROM session_members o JOIN users u ON u.id = o.user_id
                 WHERE o.session_id = i.session_id AND o.role = 'owner') AS ownerPlanStatus,
              EXISTS(SELECT 1 FROM session_members m
                 WHERE m.session_id = i.session_id AND m.user_id = ?1) AS alreadyMember
       FROM session_invites i WHERE i.id = ?2 AND i.revoked_at IS NULL`,
    )
    .bind(userId, inviteId)
    .first<{ memberCount: number; ownerPlan: Plan | null; ownerPlanStatus: PlanStatus | null; alreadyMember: number }>();
  if (!gate) return null;
  // Missing owner plan/status shouldn't happen (every session has an owner
  // row), but if it ever does, resolve to the strictest limits rather than
  // the old "pro" fallback.
  const plan = effectivePlan(gate.ownerPlan ?? "free", gate.ownerPlanStatus ?? "inactive");
  // ponytail: check-then-insert; concurrent accepts can exceed the cap by the
  // number of racers. Upgrade path if it matters: conditional INSERT...SELECT
  // guarded by the count inside the batch.
  if (!gate.alreadyMember && gate.memberCount >= PLAN_LIMITS[plan].seats) {
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
       WHERE i.id = ? AND i.revoked_at IS NULL AND sm.user_id = ?`,
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

export async function setSessionAutoDispatch(
  sessionId: string,
  ownerId: string,
  enabled: boolean,
  database = getDb(),
): Promise<boolean> {
  if ((await getActiveMembershipRole(sessionId, ownerId, database)) !== "owner") return false;
  await database
    .prepare(
      `UPDATE sessions SET auto_dispatch = ?, floor_revision = floor_revision + 1, updated_at = ?
       WHERE id = ? AND ended_at IS NULL`,
    )
    .bind(enabled ? 1 : 0, Date.now(), sessionId)
    .run();
  return true;
}

export async function leaveSession(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<"left" | "owner" | "missing"> {
  const role = await getMembershipRole(sessionId, userId, database);
  if (!role) return "missing";
  if (role === "owner") return "owner";
  await database.batch([
    database.prepare("DELETE FROM floor_assignments WHERE session_id = ? AND user_id = ?").bind(sessionId, userId),
    database.prepare("DELETE FROM session_members WHERE session_id = ? AND user_id = ?").bind(sessionId, userId),
    database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").bind(Date.now(), sessionId),
  ]);
  return "left";
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
  const owned = await database
    .prepare(
      `SELECT s.id AS id, s.title AS title
       FROM session_members sm JOIN sessions s ON s.id = sm.session_id
       WHERE sm.user_id = ? AND sm.role = 'owner'`,
    )
    .bind(userId)
    .all<{ id: string; title: string }>();

  // Same guards as deleteSession, run per owned session, before anything is
  // written — a live repository candidate or in-progress integration on any
  // one owned session blocks the entire account deletion rather than
  // silently losing that work.
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
  if (blocked.length > 0) return { blocked: "sessions", sessions: blocked };

  const now = Date.now();
  await database.batch([
    ...owned.results.map((session) => database.prepare("DELETE FROM sessions WHERE id = ?").bind(session.id)),
    // Memberships (and assignments) in sessions this user did not own —
    // session_members would cascade on its own, but floor_assignments has no
    // FK action, same reason leaveSession deletes it explicitly.
    database.prepare("DELETE FROM floor_assignments WHERE user_id = ?").bind(userId),
    database.prepare("DELETE FROM session_members WHERE user_id = ?").bind(userId),
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
       WHERE u.chatgpt_user_id = ? AND sm.session_id = ?`,
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
  database: D1DatabaseLike,
): Promise<{ ownerId: string; plan: Plan; seconds: number; endedAt: number | null } | null> {
  const row = await database
    .prepare(
      `SELECT o.user_id AS ownerId, u.plan AS plan, u.plan_status AS planStatus,
              COALESCE(um.seconds, 0) AS seconds, s.ended_at AS endedAt
       FROM session_members o
       JOIN sessions s ON s.id = o.session_id
       JOIN users u ON u.id = o.user_id
       LEFT JOIN usage_months um ON um.owner_user_id = o.user_id AND um.month = ?
       WHERE o.session_id = ? AND o.role = 'owner'`,
    )
    .bind(currentMonth(), sessionId)
    .first<{ ownerId: string; plan: Plan; planStatus: PlanStatus; seconds: number; endedAt: number | null }>();
  if (!row) return null;
  return { ownerId: row.ownerId, plan: effectivePlan(row.plan, row.planStatus), seconds: row.seconds, endedAt: row.endedAt };
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
      `SELECT u.plan AS plan, u.plan_status AS planStatus, COALESCE(um.seconds, 0) AS seconds
       FROM users u
       LEFT JOIN usage_months um ON um.owner_user_id = u.id AND um.month = ?
       WHERE u.id = ?`,
    )
    .bind(currentMonth(), userId)
    .first<{ plan: Plan; planStatus: PlanStatus; seconds: number }>();
  const plan = row?.plan ?? "free";
  const planStatus = row?.planStatus ?? "inactive";
  const effective = effectivePlan(plan, planStatus);
  return {
    plan,
    planStatus,
    effectivePlan: effective,
    seconds: row?.seconds ?? 0,
    limitHours: PLAN_LIMITS[effective].hours,
    limitSeats: PLAN_LIMITS[effective].seats,
  };
}

export async function hourQuotaExhausted(userId: string, database = getDb()): Promise<boolean> {
  const usage = await getUsageForUser(userId, database);
  return usage.seconds >= usage.limitHours * 3600;
}

function normalizeSession(record: SessionRecord): SessionSummary {
  return { ...record, memberCount: Number(record.memberCount) };
}

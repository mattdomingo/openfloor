import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getSessionForMember } from "@/db/sessions";

// drizzle/0022_account_email_merge.sql heals `users` rows that accumulated
// per-login-method duplicates before email became the account key — the
// direct cause of "Google sign-in returns 404" (a returning user's Google
// login resolved to a fresh, membership-less account instead of the one
// holding their session). These tests re-run that migration's exact SQL
// (threaded in via vitest.worker.config.ts's ACCOUNT_EMAIL_MERGE_QUERIES,
// reusing wrangler's own statement splitting) against seeded duplicate data,
// so they exercise the real migration file, not a parallel reimplementation.
//
// tests/worker/setup.ts already applied every migration, including this one,
// against an empty database — a correct no-op. To test its merge behavior
// each test here drops idx_users_email (which the migration itself created),
// seeds duplicates directly, and reapplies the migration's statements.

const db = env.DB;

async function reapplyAccountEmailMergeMigration(): Promise<void> {
  await db.prepare("DROP INDEX IF EXISTS `idx_users_email`").run();
  const queries = JSON.parse(env.ACCOUNT_EMAIL_MERGE_QUERIES) as string[];
  await db.batch(queries.map((query) => db.prepare(query)));
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

type SeedUserInput = {
  id: string;
  email: string;
  onboardedAt?: number | null;
  createdAt?: number;
  firstName?: string | null;
  lastName?: string | null;
  githubHandle?: string | null;
  avatarKey?: string | null;
  plan?: string;
  planStatus?: string;
};

async function seedUser(input: SeedUserInput): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO users (id, chatgpt_user_id, email, display_name, first_name, last_name, github_handle, avatar_key,
                           onboarded_at, plan, plan_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      `provider-${input.id}`,
      input.email,
      input.firstName ? `${input.firstName} ${input.lastName ?? ""}`.trim() : input.email,
      input.firstName ?? null,
      input.lastName ?? null,
      input.githubHandle ?? null,
      input.avatarKey ?? null,
      input.onboardedAt ?? null,
      input.plan ?? "pro",
      input.planStatus ?? "inactive",
      input.createdAt ?? now,
      now,
    )
    .run();
}

async function fetchUser(id: string) {
  return db
    .prepare(
      `SELECT id, chatgpt_user_id AS providerUserId, email, display_name AS displayName, first_name AS firstName,
              last_name AS lastName, github_handle AS githubHandle, avatar_key AS avatarKey, onboarded_at AS onboardedAt,
              plan, plan_status AS planStatus
       FROM users WHERE id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
}

async function seedSession(id: string): Promise<void> {
  const now = Date.now();
  await db
    .prepare("INSERT INTO sessions (id, title, created_at, updated_at, objective_updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, `Session ${id}`, now, now, now)
    .run();
}

async function seedSessionMember(sessionId: string, userId: string, role: "owner" | "member", joinedAt: number): Promise<void> {
  await db
    .prepare("INSERT INTO session_members (session_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
    .bind(sessionId, userId, role, joinedAt)
    .run();
}

// Each test starts from tests/worker/setup.ts's beforeAll state — every
// migration already applied against an empty database, isolated per test
// (matching every other file under tests/worker/, which reuses literal ids
// like "owner" freely across `it` blocks). idx_users_email is therefore
// already present, but it compares stored bytes (SQLite's default binary
// collation), not the application's lowercased form, so seeding two rows
// that differ only by case never trips it — only reapplyAccountEmailMergeMigration's
// own DROP/recreate matters, and that only needs to bracket the actual merge.

// Builds one row referencing `userId` in every table the migration must
// repoint, all tied to `sessionId`. Returns the ids created so callers can
// re-query them after the merge. Kept in one place so every simple-column
// table in the migration's repoint list has real coverage instead of a
// representative subset.
async function seedFullReferenceGraph(sessionId: string, userId: string) {
  const now = Date.now();

  const inviteId = nextId("invite");
  await db.prepare("INSERT INTO session_invites (id, session_id, created_by, created_at) VALUES (?, ?, ?, ?)").bind(inviteId, sessionId, userId, now).run();

  const agentId = nextId("agent");
  await db
    .prepare(
      `INSERT INTO floor_agents (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
    )
    .bind(agentId, sessionId, userId, userId, "Agent", `agent-${agentId}`, "engineer", "Do work", now, now)
    .run();

  await db
    .prepare("INSERT INTO floor_assignments (session_id, user_id, task, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sessionId, userId, "Reviewing", userId, now)
    .run();

  const messageId = nextId("message");
  await db
    .prepare("INSERT INTO floor_messages (id, session_id, author_user_id, recipient_user_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(messageId, sessionId, userId, userId, "hello", now)
    .run();

  const queueItemId = nextId("queue-item");
  await db
    .prepare(
      `INSERT INTO floor_queue_items (id, session_id, position, status, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
    )
    .bind(queueItemId, sessionId, 0, now, now)
    .run();
  const promptId = nextId("prompt");
  await db
    .prepare("INSERT INTO floor_queue_prompts (id, queue_item_id, author_user_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(promptId, queueItemId, userId, "please do this", now)
    .run();

  const connectionStateId = nextId("gh-state");
  await db
    .prepare("INSERT INTO github_connection_states (id, session_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(connectionStateId, sessionId, userId, now, now + 1_000_000)
    .run();

  const connectionId = nextId("connection");
  await db
    .prepare(
      `INSERT INTO repository_connections
        (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name,
         repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
       VALUES (?, ?, 'install-1', 'repo-1', 'node-1', 'acme', 'widgets', 'acme/widgets', 0, 'main', 'main', 'connected', ?, ?, ?)`,
    )
    .bind(connectionId, sessionId, userId, now, now)
    .run();

  const candidateId = nextId("candidate");
  await db
    .prepare(
      `INSERT INTO repository_candidates
        (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, review_ready_by, merged_by, created_at, updated_at)
       VALUES (?, ?, ?, 'branch-1', 'main', 'sha-1', 'active', ?, ?, ?, ?, ?)`,
    )
    .bind(candidateId, sessionId, connectionId, userId, userId, userId, now, now)
    .run();

  const preflightId = nextId("preflight");
  await db
    .prepare(
      `INSERT INTO repository_preflights (id, session_id, connection_id, candidate_id, candidate_sha, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'sha-1', 'passed', ?, ?, ?)`,
    )
    .bind(preflightId, sessionId, connectionId, candidateId, userId, now, now)
    .run();

  const runId = nextId("run");
  await db
    .prepare(
      `INSERT INTO agent_runs
        (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id,
         created_by, discarded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'sha-1', 1, 'integrated', 'gpt', 'sandbox-1', ?, ?, ?, ?)`,
    )
    .bind(runId, sessionId, queueItemId, agentId, candidateId, userId, userId, now, now)
    .run();

  return { inviteId, agentId, messageId, queueItemId, promptId, connectionStateId, connectionId, candidateId, preflightId, runId };
}

describe("0022_account_email_merge migration", () => {
  it("merges a duplicate created by a different login method onto the account holding the membership", async () => {
    const sessionId = nextId("session");
    await seedSession(sessionId);

    // The production scenario: an OTP account owns the membership and is
    // onboarded; a later Google login (different provider id, same mailbox,
    // different case) created a second, empty account.
    const otpUser = nextId("user");
    await seedUser({ id: otpUser, email: "dup@example.com", onboardedAt: Date.now(), createdAt: 1_000 });
    await seedSessionMember(sessionId, otpUser, "owner", 1_000);

    const googleUser = nextId("user");
    await seedUser({ id: googleUser, email: "Dup@Example.com", createdAt: 2_000 });

    await reapplyAccountEmailMergeMigration();

    const survivor = await fetchUser(otpUser);
    expect(survivor).not.toBeNull();
    const loser = await fetchUser(googleUser);
    expect(loser).toBeNull();

    const session = await getSessionForMember(sessionId, otpUser, db);
    expect(session).not.toBeNull();
    expect(session?.role).toBe("owner");
  });

  it("picks the onboarded account as survivor regardless of which account is older or has more memberships", async () => {
    const sessionA = nextId("session");
    const sessionB = nextId("session");
    await seedSession(sessionA);
    await seedSession(sessionB);

    const older = nextId("user");
    await seedUser({ id: older, email: "priority@example.com", createdAt: 500 });
    await seedSessionMember(sessionA, older, "member", 500);
    await seedSessionMember(sessionB, older, "member", 500);

    const onboarded = nextId("user");
    await seedUser({ id: onboarded, email: "Priority@Example.com", onboardedAt: Date.now(), createdAt: 9_000 });

    await reapplyAccountEmailMergeMigration();

    expect(await fetchUser(onboarded)).not.toBeNull();
    expect(await fetchUser(older)).toBeNull();
  });

  it("without an onboarded candidate, picks the account with more memberships, then the older account", async () => {
    const sessionA = nextId("session");
    const sessionB = nextId("session");
    await seedSession(sessionA);
    await seedSession(sessionB);

    const fewerMemberships = nextId("user");
    await seedUser({ id: fewerMemberships, email: "byMembership@example.com", createdAt: 100 });
    await seedSessionMember(sessionA, fewerMemberships, "member", 100);

    const moreMemberships = nextId("user");
    await seedUser({ id: moreMemberships, email: "ByMembership@Example.com", createdAt: 9_000 });
    await seedSessionMember(sessionA, moreMemberships, "member", 9_000);
    await seedSessionMember(sessionB, moreMemberships, "member", 9_000);

    await reapplyAccountEmailMergeMigration();

    expect(await fetchUser(moreMemberships)).not.toBeNull();
    expect(await fetchUser(fewerMemberships)).toBeNull();
  });

  it("repoints every user-referencing column onto the survivor", async () => {
    const sessionId = nextId("session");
    await seedSession(sessionId);

    const survivor = nextId("user");
    await seedUser({ id: survivor, email: "graph@example.com", onboardedAt: Date.now(), createdAt: 100 });

    const loser = nextId("user");
    await seedUser({ id: loser, email: "GRAPH@example.com", createdAt: 200 });

    const ids = await seedFullReferenceGraph(sessionId, loser);

    await reapplyAccountEmailMergeMigration();

    expect(await fetchUser(loser)).toBeNull();

    const invite = await db.prepare("SELECT created_by AS createdBy FROM session_invites WHERE id = ?").bind(ids.inviteId).first<{ createdBy: string }>();
    expect(invite?.createdBy).toBe(survivor);

    const agent = await db
      .prepare("SELECT created_by AS createdBy, owner_user_id AS ownerUserId FROM floor_agents WHERE id = ?")
      .bind(ids.agentId)
      .first<{ createdBy: string; ownerUserId: string }>();
    expect(agent?.createdBy).toBe(survivor);
    expect(agent?.ownerUserId).toBe(survivor);

    const assignment = await db
      .prepare("SELECT user_id AS userId, updated_by AS updatedBy FROM floor_assignments WHERE session_id = ?")
      .bind(sessionId)
      .first<{ userId: string; updatedBy: string }>();
    expect(assignment?.userId).toBe(survivor);
    expect(assignment?.updatedBy).toBe(survivor);

    const message = await db
      .prepare("SELECT author_user_id AS authorUserId, recipient_user_id AS recipientUserId FROM floor_messages WHERE id = ?")
      .bind(ids.messageId)
      .first<{ authorUserId: string; recipientUserId: string }>();
    expect(message?.authorUserId).toBe(survivor);
    expect(message?.recipientUserId).toBe(survivor);

    const prompt = await db
      .prepare("SELECT author_user_id AS authorUserId FROM floor_queue_prompts WHERE id = ?")
      .bind(ids.promptId)
      .first<{ authorUserId: string }>();
    expect(prompt?.authorUserId).toBe(survivor);

    const ghState = await db
      .prepare("SELECT user_id AS userId FROM github_connection_states WHERE id = ?")
      .bind(ids.connectionStateId)
      .first<{ userId: string }>();
    expect(ghState?.userId).toBe(survivor);

    const connection = await db
      .prepare("SELECT connected_by AS connectedBy FROM repository_connections WHERE id = ?")
      .bind(ids.connectionId)
      .first<{ connectedBy: string }>();
    expect(connection?.connectedBy).toBe(survivor);

    const candidate = await db
      .prepare("SELECT created_by AS createdBy, review_ready_by AS reviewReadyBy, merged_by AS mergedBy FROM repository_candidates WHERE id = ?")
      .bind(ids.candidateId)
      .first<{ createdBy: string; reviewReadyBy: string; mergedBy: string }>();
    expect(candidate?.createdBy).toBe(survivor);
    expect(candidate?.reviewReadyBy).toBe(survivor);
    expect(candidate?.mergedBy).toBe(survivor);

    const preflight = await db
      .prepare("SELECT created_by AS createdBy FROM repository_preflights WHERE id = ?")
      .bind(ids.preflightId)
      .first<{ createdBy: string }>();
    expect(preflight?.createdBy).toBe(survivor);

    const run = await db
      .prepare("SELECT created_by AS createdBy, discarded_by AS discardedBy FROM agent_runs WHERE id = ?")
      .bind(ids.runId)
      .first<{ createdBy: string; discardedBy: string }>();
    expect(run?.createdBy).toBe(survivor);
    expect(run?.discardedBy).toBe(survivor);
  });

  it("upgrades to owner instead of dropping to member when a duplicate's membership collides with the survivor's", async () => {
    const sessionId = nextId("session");
    await seedSession(sessionId);

    const survivor = nextId("user");
    await seedUser({ id: survivor, email: "collide@example.com", onboardedAt: Date.now(), createdAt: 100 });
    await seedSessionMember(sessionId, survivor, "member", 100);

    const loser = nextId("user");
    await seedUser({ id: loser, email: "COLLIDE@example.com", createdAt: 200 });
    await seedSessionMember(sessionId, loser, "owner", 200);

    await reapplyAccountEmailMergeMigration();

    const rows = await db.prepare("SELECT user_id AS userId, role FROM session_members WHERE session_id = ?").bind(sessionId).all<{ userId: string; role: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toEqual({ userId: survivor, role: "owner" });
  });

  it("keeps an active membership over a removed one when a duplicate's rows collide on the same session", async () => {
    const sessionId = nextId("session");
    await seedSession(sessionId);
    const remover = nextId("user");
    await seedUser({ id: remover, email: "remover@example.com" });

    const survivor = nextId("user");
    await seedUser({ id: survivor, email: "removal-collide@example.com", onboardedAt: Date.now(), createdAt: 100 });
    // The survivor's own row was removed from this session...
    await db
      .prepare("INSERT INTO session_members (session_id, user_id, role, joined_at, removed_at, removed_by) VALUES (?, ?, 'member', ?, ?, ?)")
      .bind(sessionId, survivor, 100, 500, remover)
      .run();

    const loser = nextId("user");
    await seedUser({ id: loser, email: "REMOVAL-COLLIDE@example.com", createdAt: 200 });
    // ...but the duplicate account still holds an active membership for it.
    await seedSessionMember(sessionId, loser, "member", 200);

    await reapplyAccountEmailMergeMigration();

    const rows = await db
      .prepare("SELECT user_id AS userId, removed_at AS removedAt FROM session_members WHERE session_id = ?")
      .bind(sessionId)
      .all<{ userId: string; removedAt: number | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toEqual({ userId: survivor, removedAt: null });
  });

  it("preserves the removal audit trail (removed_at/removed_by) through a merge, repointing removed_by onto the survivor", async () => {
    const sessionId = nextId("session");
    await seedSession(sessionId);

    const removingOwnerSurvivor = nextId("user");
    await seedUser({ id: removingOwnerSurvivor, email: "removing-owner@example.com", onboardedAt: Date.now(), createdAt: 100 });
    const removingOwnerLoser = nextId("user");
    await seedUser({ id: removingOwnerLoser, email: "REMOVING-OWNER@example.com", createdAt: 200 });

    const removedMember = nextId("user");
    await seedUser({ id: removedMember, email: "removed-member@example.com" });
    await db
      .prepare("INSERT INTO session_members (session_id, user_id, role, joined_at, removed_at, removed_by) VALUES (?, ?, 'member', ?, ?, ?)")
      .bind(sessionId, removedMember, 100, 900, removingOwnerLoser)
      .run();

    await reapplyAccountEmailMergeMigration();

    expect(await fetchUser(removingOwnerLoser)).toBeNull();
    const row = await db
      .prepare("SELECT removed_at AS removedAt, removed_by AS removedBy FROM session_members WHERE session_id = ? AND user_id = ?")
      .bind(sessionId, removedMember)
      .first<{ removedAt: number; removedBy: string }>();
    expect(row).toEqual({ removedAt: 900, removedBy: removingOwnerSurvivor });
  });

  it("keeps the more recently updated floor assignment when both duplicates hold one for the same session", async () => {
    const sessionId = nextId("session");
    await seedSession(sessionId);

    const survivor = nextId("user");
    await seedUser({ id: survivor, email: "assign@example.com", onboardedAt: Date.now(), createdAt: 100 });
    await db.prepare("INSERT INTO floor_assignments (session_id, user_id, task, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)").bind(sessionId, survivor, "stale task", survivor, 1_000).run();

    const loser = nextId("user");
    await seedUser({ id: loser, email: "ASSIGN@example.com", createdAt: 200 });
    await db.prepare("INSERT INTO floor_assignments (session_id, user_id, task, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)").bind(sessionId, loser, "fresh task", loser, 5_000).run();

    await reapplyAccountEmailMergeMigration();

    const rows = await db
      .prepare("SELECT user_id AS userId, task, updated_at AS updatedAt FROM floor_assignments WHERE session_id = ?")
      .bind(sessionId)
      .all<{ userId: string; task: string; updatedAt: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toEqual({ userId: survivor, task: "fresh task", updatedAt: 5_000 });
  });

  it("sums usage_months seconds instead of picking one side when both duplicates logged time in the same month", async () => {
    const survivor = nextId("user");
    await seedUser({ id: survivor, email: "usage@example.com", onboardedAt: Date.now(), createdAt: 100 });
    await db.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, '2026-08', 600)").bind(survivor).run();

    const loser = nextId("user");
    await seedUser({ id: loser, email: "USAGE@example.com", createdAt: 200 });
    await db.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, '2026-08', 900)").bind(loser).run();
    await db.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, '2026-07', 300)").bind(loser).run();

    await reapplyAccountEmailMergeMigration();

    const rows = await db.prepare("SELECT month, seconds FROM usage_months WHERE owner_user_id = ? ORDER BY month").bind(survivor).all<{ month: string; seconds: number }>();
    expect(rows.results).toEqual([
      { month: "2026-07", seconds: 300 },
      { month: "2026-08", seconds: 1500 },
    ]);
  });

  it("fills profile fields the survivor is missing from a duplicate that has them, without downgrading plan or plan_status", async () => {
    const survivor = nextId("user");
    await seedUser({ id: survivor, email: "profile@example.com", onboardedAt: Date.now(), createdAt: 100, firstName: "Sam", lastName: null, plan: "pro", planStatus: "inactive" });

    const loser = nextId("user");
    await seedUser({
      id: loser,
      email: "PROFILE@example.com",
      createdAt: 200,
      firstName: "Ignored",
      lastName: "Owner",
      githubHandle: "sam-gh",
      avatarKey: "avatar-key-1",
      plan: "enterprise",
      planStatus: "active",
    });

    await reapplyAccountEmailMergeMigration();

    const merged = await fetchUser(survivor);
    expect(merged?.firstName).toBe("Sam"); // never overwritten, only filled when null
    expect(merged?.lastName).toBe("Owner");
    expect(merged?.githubHandle).toBe("sam-gh");
    expect(merged?.avatarKey).toBe("avatar-key-1");
    expect(merged?.plan).toBe("enterprise");
    expect(merged?.planStatus).toBe("active");
  });

  it("normalizes the stored email to lowercase on the survivor even before any duplicate exists", async () => {
    const user = nextId("user");
    await seedUser({ id: user, email: "Mixed.Case@Example.com" });

    await reapplyAccountEmailMergeMigration();

    const row = await fetchUser(user);
    expect(row?.email).toBe("mixed.case@example.com");
  });

  it("is idempotent: running it again after all duplicates are gone changes nothing", async () => {
    const sessionId = nextId("session");
    await seedSession(sessionId);
    const survivor = nextId("user");
    await seedUser({ id: survivor, email: "idempotent@example.com", onboardedAt: Date.now() });
    await seedSessionMember(sessionId, survivor, "owner", Date.now());

    const loser = nextId("user");
    await seedUser({ id: loser, email: "IDEMPOTENT@example.com" });

    await reapplyAccountEmailMergeMigration();
    const afterFirst = await fetchUser(survivor);

    await reapplyAccountEmailMergeMigration();
    const afterSecond = await fetchUser(survivor);

    expect(afterSecond).toEqual(afterFirst);
    const session = await getSessionForMember(sessionId, survivor, db);
    expect(session?.role).toBe("owner");
  });

  it("rejects a second account created with a duplicate email once the unique index is back in place", async () => {
    const user = nextId("user");
    await seedUser({ id: user, email: "unique@example.com" });
    await reapplyAccountEmailMergeMigration();

    await expect(
      db
        .prepare("INSERT INTO users (id, chatgpt_user_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(nextId("user"), nextId("provider"), "unique@example.com", "Someone", Date.now(), Date.now())
        .run(),
    ).rejects.toThrow();
  });
});

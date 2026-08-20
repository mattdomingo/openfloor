import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createFloorAgent, createFloorMessage, updateFloorAssignment } from "@/db/floor";
import { getSessionContext } from "@/db/session-context";
import { acceptInvite, createSession, upsertUser } from "@/db/sessions";
import { parseAgentInput } from "@/lib/validation";

function identity(id: string, name: string) {
  return { providerUserId: `context-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function room(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const created = await createSession(owner.id, { title: `Floor ${suffix}`, objective: `Ship ${suffix}.` }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  return { sessionId: created.session.id, owner, member };
}

async function addAgent(sessionId: string, ownerUserId: string, name: string, task: string) {
  const input = parseAgentInput({ name, role: "Engineer", task, ownerUserId });
  if (!input) throw new Error("Invalid test agent");
  const floor = await createFloorAgent(sessionId, ownerUserId, input, env.DB);
  const agent = floor?.agents.find((candidate) => candidate.name === name);
  if (!agent) throw new Error("Agent was not created");
  return agent.id;
}

/** Mirrors tests/worker/run-activity.test.ts's connection/candidate scaffolding. */
async function repositoryScaffold(sessionId: string, userId: string) {
  const now = Date.now();
  const connectionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
     VALUES (?, ?, 'inst', 'repo', 'node', 'owner', 'name', 'owner/name', 1, 'main', 'main', 'ready', ?, ?, ?)`,
  ).bind(connectionId, sessionId, userId, now, now).run();
  const candidateId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, candidate_sha, pull_request_number, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'candidate-branch', 'main', 'sha-base', 'sha-candidate', 7, 'active', ?, ?, ?)`,
  ).bind(candidateId, sessionId, connectionId, userId, now, now).run();
  return { connectionId, candidateId };
}

async function insertQueueRow(sessionId: string, agentId: string | null, status: string, position: number, assignedReason: string | null = null) {
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, assigned_by, assigned_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, sessionId, agentId, position, status, agentId ? "user" : null, assignedReason, now, now).run();
  return id;
}

async function insertPrompt(queueItemId: string, authorUserId: string, text: string) {
  await env.DB.prepare(
    `INSERT INTO floor_queue_prompts (id, queue_item_id, author_user_id, text, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), queueItemId, authorUserId, text, Date.now()).run();
}

async function insertRun(sessionId: string, agentId: string, candidateId: string, userId: string, queueItemId: string, status: string, options: { summary?: string; conflictReason?: string; attempt?: number } = {}) {
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, summary, conflict_reason, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sha-run', ?, ?, 'test-model', 'sandbox', ?, ?, ?, ?, ?)`,
  ).bind(id, sessionId, queueItemId, agentId, candidateId, options.attempt ?? 1, status, options.summary ?? null, options.conflictReason ?? null, userId, now, now).run();
  return id;
}

async function insertFile(runId: string, path: string) {
  await env.DB.prepare(
    `INSERT INTO agent_run_files (id, run_id, path, change_kind, additions, deletions, diff_preview, created_at) VALUES (?, ?, ?, 'add', 1, 0, '', ?)`,
  ).bind(crypto.randomUUID(), runId, path, Date.now()).run();
}

async function insertFileEditEvent(runId: string, detail: string, sequence: number) {
  await env.DB.prepare(
    `INSERT INTO agent_run_events (id, run_id, sequence, kind, detail, created_at) VALUES (?, ?, ?, 'file_edit', ?, ?)`,
  ).bind(crypto.randomUUID(), runId, sequence, detail, Date.now()).run();
}

describe("getSessionContext", () => {
  it("returns null for a session that does not exist", async () => {
    expect(await getSessionContext(crypto.randomUUID(), undefined, env.DB)).toBeNull();
  });

  it("assembles the floor brief: agents, assignments, bucketed runs, queue, and public-only chat", async () => {
    const { sessionId, owner, member } = await room("brief");
    const builderId = await addAgent(sessionId, owner.id, "Builder", "Implements backend routes.");
    const reviewerId = await addAgent(sessionId, member.id, "Reviewer", "Reviews pull requests.");
    await updateFloorAssignment(sessionId, owner.id, member.id, { task: "Coordinate the release" }, env.DB);
    const { candidateId } = await repositoryScaffold(sessionId, owner.id);

    // Public chat is visible; a direct message must never appear in the brief.
    await createFloorMessage(sessionId, owner.id, { text: "Let's keep the change small.", recipientUserId: null }, env.DB);
    await createFloorMessage(sessionId, owner.id, { text: "secret DM, must not leak", recipientUserId: member.id }, env.DB);

    // An already-integrated run for Builder, with a landed file.
    const integratedQueueItem = await insertQueueRow(sessionId, builderId, "completed", 1);
    await insertPrompt(integratedQueueItem, owner.id, "Add the health check endpoint");
    const integratedRunId = await insertRun(sessionId, builderId, candidateId, owner.id, integratedQueueItem, "integrated", { summary: "Added /healthz." });
    await insertFile(integratedRunId, "app/api/healthz/route.ts");

    // An in-flight run for Reviewer, with a live file_edit event.
    const runningQueueItem = await insertQueueRow(sessionId, reviewerId, "running", 2);
    await insertPrompt(runningQueueItem, member.id, "Tighten the review checklist");
    const runningRunId = await insertRun(sessionId, reviewerId, candidateId, member.id, runningQueueItem, "running");
    await insertFileEditEvent(runningRunId, "edited components/session/ReviewScreen.tsx", 1);

    // A blocked/conflicted run.
    const blockedQueueItem = await insertQueueRow(sessionId, builderId, "blocked", 3, "Matched 1 task keyword(s): route");
    await insertPrompt(blockedQueueItem, owner.id, "Rename the endpoint");
    await insertRun(sessionId, builderId, candidateId, owner.id, blockedQueueItem, "conflicted", { conflictReason: "GitHub reported a merge conflict." });

    // A queued, unassigned item still waiting.
    const queuedItem = await insertQueueRow(sessionId, null, "queued", 4);
    await insertPrompt(queuedItem, member.id, "Add rate limiting");

    const snapshot = await getSessionContext(sessionId, undefined, env.DB);
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.session).toEqual({ title: "Floor brief", objective: "Ship brief." });
    expect(snapshot.repository).toEqual({ fullName: "owner/name", baseBranch: "main" });
    expect(snapshot.candidate).toEqual({ branchName: "candidate-branch", sha: "sha-candidate", pullRequestNumber: 7 });

    expect(snapshot.agents.map((agent) => agent.name)).toEqual(["Builder", "Reviewer"]);
    expect(snapshot.assignments).toEqual([{ userName: "Member Example", task: "Coordinate the release" }]);

    expect(snapshot.integratedRuns).toHaveLength(1);
    expect(snapshot.integratedRuns[0]).toMatchObject({ agentName: "Builder", summary: "Added /healthz.", files: ["app/api/healthz/route.ts"] });
    expect(snapshot.integratedRuns[0].prompts).toEqual([{ authorName: "Owner Example", text: "Add the health check endpoint" }]);

    expect(snapshot.inFlightRuns).toHaveLength(1);
    expect(snapshot.inFlightRuns[0]).toMatchObject({ agentName: "Reviewer", status: "running" });
    expect(snapshot.inFlightRuns[0].recentEdits).toEqual(["edited components/session/ReviewScreen.tsx"]);

    expect(snapshot.blockedRuns).toHaveLength(1);
    expect(snapshot.blockedRuns[0]).toMatchObject({ agentName: "Builder", status: "conflicted", conflictReason: "GitHub reported a merge conflict." });

    // Completed and running queue items are represented via the run buckets above,
    // not duplicated as "waiting" — only genuinely queued/blocked items remain.
    const remainingQueue = snapshot.queue.map((item) => item.status).sort();
    expect(remainingQueue).toEqual(["blocked", "queued", "running"]);
    const stillQueued = snapshot.queue.find((item) => item.id === queuedItem);
    expect(stillQueued?.prompts).toEqual([{ authorName: "Member Example", text: "Add rate limiting" }]);

    expect(snapshot.chat).toEqual([{ authorName: "Owner Example", text: "Let's keep the change small." }]);
    expect(snapshot.chat.some((message) => message.text.includes("secret DM"))).toBe(false);
  });

  it("returns prior attempts for the viewer's own queue item, excluding the current run", async () => {
    const { sessionId, owner } = await room("attempts");
    const builderId = await addAgent(sessionId, owner.id, "Builder", "Implements backend routes.");
    const { candidateId } = await repositoryScaffold(sessionId, owner.id);
    const queueItemId = await insertQueueRow(sessionId, builderId, "blocked", 1);
    await insertPrompt(queueItemId, owner.id, "Fix the flaky check");
    const firstAttempt = await insertRun(sessionId, builderId, candidateId, owner.id, queueItemId, "conflicted", { attempt: 1, conflictReason: "First conflict." });
    const secondAttempt = await insertRun(sessionId, builderId, candidateId, owner.id, queueItemId, "running", { attempt: 2 });

    const snapshot = await getSessionContext(sessionId, { runId: secondAttempt, queueItemId }, env.DB);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.priorAttempts).toEqual([{ attempt: 1, status: "conflicted", conflictReason: "First conflict." }]);
    // The current run must not appear in its own in-flight bucket; the earlier
    // conflicted attempt is still a real floor-wide fact and does appear in
    // "Blocked or failed earlier", alongside being called out in priorAttempts.
    expect(snapshot?.inFlightRuns.some((run) => run.id === secondAttempt)).toBe(false);
    expect(snapshot?.blockedRuns.some((run) => run.id === firstAttempt)).toBe(true);
  });
});

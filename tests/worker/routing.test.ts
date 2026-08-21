import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createFloorAgent, createFloorQueueItem } from "@/db/floor";
import { runRoutingTick, SESSION_RUN_CAP, type RoutingDeps } from "@/db/routing";
import { acceptInvite, createSession, setSessionAutoDispatch, upsertUser } from "@/db/sessions";
import type { StartRunResult } from "@/lib/agent-run-start";
import { parseAgentInput } from "@/lib/validation";

function identity(id: string, name: string) {
  return { providerUserId: `routing-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function routingRoom(suffix: string, autoDispatch = true) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const created = await createSession(owner.id, { title: `Routing ${suffix}`, objective: null }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  if (autoDispatch) await setSessionAutoDispatch(created.session.id, owner.id, true, env.DB);
  return { sessionId: created.session.id, owner, member };
}

async function addAgent(sessionId: string, ownerUserId: string, name: string, role: string, task: string) {
  const input = parseAgentInput({ name, role, task, ownerUserId });
  if (!input) throw new Error("Invalid test agent");
  const floor = await createFloorAgent(sessionId, ownerUserId, input, env.DB);
  const agent = floor?.agents.find((candidate) => candidate.name === name);
  if (!agent) throw new Error("Agent was not created");
  return agent.id;
}

/** Default dispatch stub: create a real running agent_runs row and flip the item, like createAgentRun does. */
function startRunStub(results: StartRunResult[] = []): { calls: Array<{ queueItemId: string; userId: string }>; deps: RoutingDeps } {
  const calls: Array<{ queueItemId: string; userId: string }> = [];
  return {
    calls,
    deps: {
      startRun: async (sessionId, queueItemId, userId) => {
        calls.push({ queueItemId, userId });
        const scripted = results.shift();
        if (scripted) return scripted;
        const item = await env.DB.prepare("SELECT agent_id AS agentId FROM floor_queue_items WHERE id = ?")
          .bind(queueItemId).first<{ agentId: string }>();
        const runId = await insertRunRow(sessionId, item!.agentId, userId, "running", Date.now(), queueItemId);
        await env.DB.prepare("UPDATE floor_queue_items SET status = 'running' WHERE id = ? AND session_id = ?")
          .bind(queueItemId, sessionId).run();
        return { ok: true, runId };
      },
    },
  };
}

async function decisions(sessionId: string) {
  const result = await env.DB.prepare(
    "SELECT queue_item_id AS queueItemId, agent_id AS agentId, run_id AS runId, decision, reason, candidates, triggered_by AS triggeredBy FROM routing_decisions WHERE session_id = ? ORDER BY created_at, rowid",
  ).bind(sessionId).all<{ queueItemId: string | null; agentId: string | null; runId: string | null; decision: string; reason: string; candidates: string; triggeredBy: string }>();
  return result.results;
}

async function queueItem(id: string) {
  return env.DB.prepare(
    "SELECT agent_id AS agentId, status, assigned_by AS assignedBy, assigned_reason AS assignedReason FROM floor_queue_items WHERE id = ?",
  ).bind(id).first<{ agentId: string | null; status: string; assignedBy: string | null; assignedReason: string | null }>();
}

/** Insert a run row, creating connection/candidate scaffolding on first use. Without a queueItemId a backing running item is created. */
async function insertRunRow(sessionId: string, agentId: string, userId: string, status: string, createdAt: number, queueItemId?: string): Promise<string> {
  const connection = await env.DB.prepare("SELECT id FROM repository_connections WHERE session_id = ?").bind(sessionId).first<{ id: string }>();
  let connectionId = connection?.id;
  if (!connectionId) {
    connectionId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
       VALUES (?, ?, 'inst', 'repo', 'node', 'owner', 'name', 'owner/name', 1, 'main', 'main', 'ready', ?, ?, ?)`,
    ).bind(connectionId, sessionId, userId, createdAt, createdAt).run();
  }
  const candidate = await env.DB.prepare("SELECT id FROM repository_candidates WHERE session_id = ?").bind(sessionId).first<{ id: string }>();
  let candidateId = candidate?.id;
  if (!candidateId) {
    candidateId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', 'sha-base', 'active', ?, ?, ?)`,
    ).bind(candidateId, sessionId, connectionId, `candidate-${candidateId}`, userId, createdAt, createdAt).run();
  }
  let backingItemId = queueItemId;
  if (!backingItemId) {
    backingItemId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, created_at, updated_at)
       VALUES (?, ?, ?, 999, 'running', ?, ?)`,
    ).bind(backingItemId, sessionId, agentId, createdAt, createdAt).run();
  }
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sha-run', 1, ?, 'test-model', 'sandbox', ?, ?, ?)`,
  ).bind(runId, sessionId, backingItemId, agentId, candidateId, status, userId, createdAt, createdAt).run();
  return runId;
}

describe("agent router tick", () => {
  afterEach(async () => {
    // Retire active runs so the shared global budget does not leak across tests.
    await env.DB.prepare(
      "UPDATE agent_runs SET status = 'integrated' WHERE status IN ('provisioning', 'running', 'checking', 'cancel_requested')",
    ).run();
  });

  it("is a no-op when auto-dispatch is off", async () => {
    const room = await routingRoom("off", false);
    await addAgent(room.sessionId, room.owner.id, "Lumen", "Backend", "Own the auth api");
    await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Fix the auth bug", agentId: null }, env.DB);
    const stub = startRunStub();
    const outcome = await runRoutingTick(room.sessionId, "enqueue", stub.deps, env.DB);
    expect(outcome).toEqual({ acted: false, held: false, revision: null });
    expect(stub.calls).toHaveLength(0);
    expect(await decisions(room.sessionId)).toHaveLength(0);
  });

  it("assigns by keyword overlap with an explainable reason and candidate snapshot", async () => {
    const room = await routingRoom("assign");
    await addAgent(room.sessionId, room.owner.id, "Nova", "Frontend", "Own the login screen styling");
    const backendId = await addAgent(room.sessionId, room.owner.id, "Lumen", "Backend", "Own the auth api middleware");
    const floor = await createFloorQueueItem(room.sessionId, room.member.id, { prompt: "Refactor the auth middleware validation", agentId: null }, env.DB);
    const itemId = floor!.queue[0].id;
    const stub = startRunStub();
    const outcome = await runRoutingTick(room.sessionId, "enqueue", stub.deps, env.DB);
    expect(outcome.acted).toBe(true);
    expect(outcome.revision).not.toBeNull();

    const item = await queueItem(itemId);
    expect(item).toEqual(expect.objectContaining({ agentId: backendId, assignedBy: "router" }));
    expect(item?.assignedReason).toMatch(/^Matched 2 task keyword\(s\): /);

    const recorded = await decisions(room.sessionId);
    const assigned = recorded.find((decision) => decision.decision === "assigned");
    expect(assigned).toEqual(expect.objectContaining({ queueItemId: itemId, agentId: backendId, triggeredBy: "enqueue" }));
    const candidates = JSON.parse(assigned!.candidates) as Array<{ agentId: string; overlap: number; eligible: boolean }>;
    expect(candidates).toHaveLength(2);
    expect(candidates.find((candidate) => candidate.agentId === backendId)?.overlap).toBe(2);

    // Dispatch followed assignment; item is running and the stub was invoked as the owner.
    expect(stub.calls).toEqual([{ queueItemId: itemId, userId: room.owner.id }]);
    expect(recorded.find((decision) => decision.decision === "dispatched")).toBeTruthy();

    // Second tick is idempotent: nothing queued remains, nothing new happens.
    const secondStub = startRunStub();
    const second = await runRoutingTick(room.sessionId, "alarm", secondStub.deps, env.DB);
    expect(second.acted).toBe(false);
    expect(secondStub.calls).toHaveLength(0);
  });

  it("falls back to least-recently-used round-robin when no keywords match", async () => {
    const room = await routingRoom("roundrobin");
    const veteranId = await addAgent(room.sessionId, room.owner.id, "Vera", "Generalist", "Anything goes here");
    const freshId = await addAgent(room.sessionId, room.owner.id, "Faye", "Generalist", "Anything goes here");
    await insertRunRow(room.sessionId, veteranId, room.owner.id, "integrated", Date.now() - 60_000);
    const floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Zzz unrelated wording entirely", agentId: null }, env.DB);
    const itemId = floor!.queue.find((item) => item.position !== 999)!.id;
    const stub = startRunStub();
    await runRoutingTick(room.sessionId, "enqueue", stub.deps, env.DB);
    const item = await queueItem(itemId);
    expect(item?.agentId).toBe(freshId);
    expect(item?.assignedReason).toBe("No keyword match; least recently used agent");
  });

  it("skips items whose agent is busy and dispatches idle agents", async () => {
    const room = await routingRoom("busy");
    const busyId = await addAgent(room.sessionId, room.owner.id, "Busy", "Backend", "auth work");
    const idleId = await addAgent(room.sessionId, room.owner.id, "Idle", "Frontend", "screen work");
    await insertRunRow(room.sessionId, busyId, room.owner.id, "running", Date.now() - 5_000);
    const first = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "More auth work", agentId: busyId }, env.DB);
    const busyItemId = first!.queue.find((item) => item.agentId === busyId && item.status === "queued")!.id;
    const second = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "More screen work", agentId: idleId }, env.DB);
    const idleItemId = second!.queue.find((item) => item.agentId === idleId)!.id;
    const stub = startRunStub();
    const outcome = await runRoutingTick(room.sessionId, "alarm", stub.deps, env.DB);
    expect(outcome.acted).toBe(true);
    expect(stub.calls).toEqual([{ queueItemId: idleItemId, userId: room.owner.id }]);
    const recorded = await decisions(room.sessionId);
    expect(recorded.find((decision) => decision.queueItemId === busyItemId)).toEqual(
      expect.objectContaining({ decision: "skipped", reason: "Agent Busy is busy" }),
    );
    expect(recorded.find((decision) => decision.queueItemId === idleItemId)?.decision).toBe("dispatched");
  });

  it("holds with a budget reason when the session run cap is reached", async () => {
    const room = await routingRoom("capacity");
    const agentA = await addAgent(room.sessionId, room.owner.id, "Alpha", "Backend", "api work");
    const agentB = await addAgent(room.sessionId, room.owner.id, "Beta", "Frontend", "ui work");
    const agentC = await addAgent(room.sessionId, room.owner.id, "Gamma", "Docs", "doc work");
    await insertRunRow(room.sessionId, agentA, room.owner.id, "running", Date.now() - 10_000);
    await insertRunRow(room.sessionId, agentB, room.owner.id, "checking", Date.now() - 9_000);
    await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Write the docs", agentId: agentC }, env.DB);
    const stub = startRunStub();
    const outcome = await runRoutingTick(room.sessionId, "alarm", stub.deps, env.DB);
    expect(outcome.held).toBe(true);
    expect(stub.calls).toHaveLength(0);
    const recorded = await decisions(room.sessionId);
    expect(recorded).toEqual([
      expect.objectContaining({ decision: "held", reason: `Session run cap reached (${SESSION_RUN_CAP} active)` }),
    ]);
  });

  it("holds and stops dispatching when preconditions are not ready", async () => {
    const room = await routingRoom("notready");
    const agentA = await addAgent(room.sessionId, room.owner.id, "Alpha", "Backend", "api work");
    const agentB = await addAgent(room.sessionId, room.owner.id, "Beta", "Frontend", "ui work");
    await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Backend api change", agentId: agentA }, env.DB);
    await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Frontend ui change", agentId: agentB }, env.DB);
    const stub = startRunStub([
      { ok: false, kind: "not_ready", message: "Configure at least one required check command before running agents." },
    ]);
    const outcome = await runRoutingTick(room.sessionId, "toggle", stub.deps, env.DB);
    expect(outcome.held).toBe(true);
    expect(stub.calls).toHaveLength(1);
    const recorded = await decisions(room.sessionId);
    expect(recorded).toEqual([
      expect.objectContaining({ decision: "held", reason: "Configure at least one required check command before running agents." }),
    ]);
  });

  it("holds with backoff, and does not throw, when the owner is out of session hours", async () => {
    // The regression this guards: a quota check that throws instead of
    // returning a StartRunResult would hit worker/session-router.ts's bare
    // catch and retry every 60s forever, since "out of hours" does not
    // resolve until the month rolls over — unlike "not_ready", which is a
    // transient precondition. Scripting the union variant here (as
    // lib/agent-run-start.ts actually returns it) proves runRoutingTick
    // treats it exactly like any other session-wide precondition: held,
    // recorded, no throw.
    const room = await routingRoom("quota");
    const agentA = await addAgent(room.sessionId, room.owner.id, "Alpha", "Backend", "api work");
    await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Backend api change", agentId: agentA }, env.DB);
    const stub = startRunStub([
      { ok: false, kind: "quota_exhausted", message: "Your plan's monthly session hours are used up." },
    ]);
    const outcome = await runRoutingTick(room.sessionId, "toggle", stub.deps, env.DB);
    expect(outcome.held).toBe(true);
    expect(stub.calls).toHaveLength(1);
    const recorded = await decisions(room.sessionId);
    expect(recorded).toEqual([
      expect.objectContaining({ decision: "held", reason: "Your plan's monthly session hours are used up." }),
    ]);
  });

  it("holds when no agents exist and never re-assigns user-assigned items", async () => {
    const emptyRoom = await routingRoom("noagents");
    await createFloorQueueItem(emptyRoom.sessionId, emptyRoom.owner.id, { prompt: "Anything", agentId: null }, env.DB);
    const stub = startRunStub();
    const outcome = await runRoutingTick(emptyRoom.sessionId, "enqueue", stub.deps, env.DB);
    expect(outcome.held).toBe(true);
    expect(await decisions(emptyRoom.sessionId)).toEqual([
      expect.objectContaining({ decision: "held", reason: "No agents exist in this session" }),
    ]);

    const room = await routingRoom("userpick");
    const pickedId = await addAgent(room.sessionId, room.owner.id, "Picked", "Backend", "api work");
    await addAgent(room.sessionId, room.owner.id, "Other", "Backend", "api work");
    const floor = await createFloorQueueItem(room.sessionId, room.member.id, { prompt: "Backend api change", agentId: pickedId }, env.DB);
    const itemId = floor!.queue[0].id;
    expect((await queueItem(itemId))?.assignedBy).toBe("user");
    const pickedStub = startRunStub();
    await runRoutingTick(room.sessionId, "enqueue", pickedStub.deps, env.DB);
    const item = await queueItem(itemId);
    expect(item?.agentId).toBe(pickedId);
    expect(item?.assignedBy).toBe("user");
    expect((await decisions(room.sessionId)).filter((decision) => decision.decision === "assigned")).toHaveLength(0);
  });
});

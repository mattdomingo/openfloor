import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POST as postRunEvents } from "@/app/runtime/run/events/route";
import { createFloorAgent } from "@/db/floor";
import {
  getRunEventsForMember,
  insertRunActivityEvents,
  markRunChecking,
  markRunRunning,
  MAX_RUNNER_EVENTS_PER_RUN,
  RUNNER_SEQUENCE_BASE,
} from "@/db/runs";
import { acceptInvite, createSession, upsertUser } from "@/db/sessions";
import { signRunGatewayToken, type RunGatewayClaims } from "@/lib/runtime-token";
import { parseAgentInput } from "@/lib/validation";
import type { PresenceEvent } from "@/lib/session-types";

const SECRET = "worker-test-runtime-gateway-secret";

function identity(id: string, name: string) {
  return { providerUserId: `activity-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function room(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const created = await createSession(owner.id, { title: `Activity ${suffix}`, objective: null }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  return { sessionId: created.session.id, owner, member };
}

async function addAgent(sessionId: string, ownerUserId: string) {
  const input = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement changes", ownerUserId });
  if (!input) throw new Error("Invalid test agent");
  const floor = await createFloorAgent(sessionId, ownerUserId, input, env.DB);
  const agent = floor?.agents.find((candidate) => candidate.name === "Builder");
  if (!agent) throw new Error("Agent was not created");
  return agent.id;
}

/** Insert a run row plus the connection/candidate scaffolding getRunExecutionContext joins against. */
async function insertRunRow(sessionId: string, agentId: string, userId: string, status: string): Promise<string> {
  const now = Date.now();
  const connection = await env.DB.prepare("SELECT id FROM repository_connections WHERE session_id = ?").bind(sessionId).first<{ id: string }>();
  let connectionId = connection?.id;
  if (!connectionId) {
    connectionId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
       VALUES (?, ?, 'inst', 'repo', 'node', 'owner', 'name', 'owner/name', 1, 'main', 'main', 'ready', ?, ?, ?)`,
    ).bind(connectionId, sessionId, userId, now, now).run();
  }
  const candidate = await env.DB.prepare("SELECT id FROM repository_candidates WHERE session_id = ?").bind(sessionId).first<{ id: string }>();
  let candidateId = candidate?.id;
  if (!candidateId) {
    candidateId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', 'sha-base', 'active', ?, ?, ?)`,
    ).bind(candidateId, sessionId, connectionId, `candidate-${candidateId}`, userId, now, now).run();
  }
  const queueItemId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, created_at, updated_at)
     VALUES (?, ?, ?, 999, 'running', ?, ?)`,
  ).bind(queueItemId, sessionId, agentId, now, now).run();
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sha-run', 1, ?, 'test-model', 'sandbox', ?, ?, ?)`,
  ).bind(runId, sessionId, queueItemId, agentId, candidateId, status, userId, now, now).run();
  return runId;
}

async function runningRun(suffix: string) {
  const { sessionId, owner, member } = await room(suffix);
  const agentId = await addAgent(sessionId, owner.id);
  const runId = await insertRunRow(sessionId, agentId, owner.id, "running");
  return { sessionId, owner, member, agentId, runId };
}

function eventsToken(runId: string, sessionId: string, overrides: Partial<RunGatewayClaims> = {}) {
  return signRunGatewayToken({
    runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "events", ...overrides,
  }, SECRET);
}

function postRequest(token: string, body: unknown) {
  return postRunEvents(new Request("http://localhost/runtime/run/events", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }));
}

function runnerEvent(offset: number, kind = "reasoning", detail = `activity ${offset}`) {
  return { sequence: RUNNER_SEQUENCE_BASE + offset, kind, detail };
}

describe("run activity ingest route", () => {
  it("accepts runner events, persists them, and ignores duplicate sequences", async () => {
    const { sessionId, owner, runId } = await runningRun("ingest");
    const token = await eventsToken(runId, sessionId);
    const first = await postRequest(token, { events: [runnerEvent(1), runnerEvent(2, "command", "$ npm test")] });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: 2, stop: false });

    const duplicate = await postRequest(token, { events: [runnerEvent(2, "command", "$ replayed"), runnerEvent(3)] });
    expect(await duplicate.json()).toEqual({ accepted: 1, stop: false });

    const stored = await getRunEventsForMember(sessionId, runId, owner.id, 0, env.DB);
    expect(stored?.map((event) => [event.sequence, event.kind])).toEqual([
      [RUNNER_SEQUENCE_BASE + 1, "reasoning"],
      [RUNNER_SEQUENCE_BASE + 2, "command"],
      [RUNNER_SEQUENCE_BASE + 3, "reasoning"],
    ]);
    expect(stored?.[1].detail).toBe("$ npm test");
  });

  it("rejects tokens for other operations, other runs, and terminal statuses with 404", async () => {
    const { sessionId, owner, agentId, runId } = await runningRun("auth");
    const openaiToken = await signRunGatewayToken({
      runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "openai",
    }, SECRET);
    expect((await postRequest(openaiToken, { events: [runnerEvent(1)] })).status).toBe(404);

    const mismatched = await eventsToken(runId, sessionId, { candidateSha: "sha-other" });
    expect((await postRequest(mismatched, { events: [runnerEvent(1)] })).status).toBe(404);

    const readyRunId = await insertRunRow(sessionId, agentId, owner.id, "ready");
    const terminal = await eventsToken(readyRunId, sessionId);
    expect((await postRequest(terminal, { events: [runnerEvent(1)] })).status).toBe(404);
  });

  it("rejects malformed payloads and truncates oversized details", async () => {
    const { sessionId, owner, runId } = await runningRun("validate");
    const token = await eventsToken(runId, sessionId);
    expect((await postRequest(token, { events: [] })).status).toBe(400);
    expect((await postRequest(token, { events: [{ sequence: 5, kind: "reasoning", detail: "below base" }] })).status).toBe(400);
    expect((await postRequest(token, { events: [runnerEvent(1, "surprise")] })).status).toBe(400);
    expect((await postRequest(token, { events: Array.from({ length: 51 }, (_, index) => runnerEvent(index + 1)) })).status).toBe(400);

    const long = await postRequest(token, { events: [runnerEvent(1, "agent_message", "x".repeat(5_000))] });
    expect(long.status).toBe(200);
    const stored = await getRunEventsForMember(sessionId, runId, owner.id, 0, env.DB);
    expect(stored?.[0].detail).toHaveLength(2_000);
  });

  it("stops the runner once the per-run cap is reached", async () => {
    const { sessionId, runId } = await runningRun("cap");
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
       INSERT INTO agent_run_events (id, run_id, sequence, kind, detail, created_at)
       SELECT lower(hex(randomblob(16))), ?, ? + n, 'reasoning', 'filler', 0 FROM seq`,
    ).bind(MAX_RUNNER_EVENTS_PER_RUN, runId, RUNNER_SEQUENCE_BASE).run();
    const token = await eventsToken(runId, sessionId);
    const response = await postRequest(token, { events: [runnerEvent(MAX_RUNNER_EVENTS_PER_RUN + 1)] });
    expect(await response.json()).toEqual({ accepted: 0, stop: true });
  });

  it("broadcasts accepted events to the session presence sockets", async () => {
    const { sessionId, runId, agentId } = await runningRun("broadcast");
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(sessionId));
    const connection = await stub.fetch("https://presence.internal/connect", {
      headers: { upgrade: "websocket", "x-openfloor-user-id": "viewer", "x-openfloor-display-name": "Viewer" },
    });
    const socket = connection.webSocket;
    if (!socket) throw new Error("Missing WebSocket");
    const frames: PresenceEvent[] = [];
    const activityFrame = new Promise<PresenceEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for run.activity")), 2_000);
      socket.addEventListener("message", (event) => {
        const parsed = JSON.parse(String(event.data)) as PresenceEvent;
        frames.push(parsed);
        if (parsed.type === "run.activity") { clearTimeout(timer); resolve(parsed); }
      });
    });
    socket.accept();

    const token = await eventsToken(runId, sessionId);
    const response = await postRequest(token, { events: [runnerEvent(1, "command", "$ npm run build")] });
    expect(response.status).toBe(200);
    await expect(activityFrame).resolves.toEqual(expect.objectContaining({
      type: "run.activity",
      runId,
      agentId,
      events: [expect.objectContaining({ sequence: RUNNER_SEQUENCE_BASE + 1, kind: "command", detail: "$ npm run build" })],
    }));
    socket.close(1000, "done");
  });

  it("rejects invalid direct broadcasts at the durable object", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("activity-invalid-broadcast"));
    const response = await stub.fetch("https://presence.internal/run-activity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run", agentId: "agent", events: [{ bad: true }] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("run activity read path", () => {
  it("merges coarse workflow events with runner events in sequence order", async () => {
    const { sessionId, owner, runId } = await runningRun("merge");
    await markRunRunning(runId, `proc-${runId}`, env.DB);
    await insertRunActivityEvents(runId, [
      { sequence: RUNNER_SEQUENCE_BASE + 1, kind: "reasoning", detail: "Thinking through the change." },
    ], env.DB);
    await markRunChecking(runId, `thread-${runId}`, "Done.", env.DB);

    const events = await getRunEventsForMember(sessionId, runId, owner.id, 0, env.DB);
    expect(events?.map((event) => event.kind)).toEqual(["running", "reasoning", "checking"]);
    expect(events?.map((event) => event.sequence)).toEqual([...events!.map((event) => event.sequence)].sort((a, b) => a - b));
  });

  it("filters with the after cursor and hides events from non-members", async () => {
    const { sessionId, owner, member, runId } = await runningRun("read-auth");
    await insertRunActivityEvents(runId, [
      { sequence: RUNNER_SEQUENCE_BASE + 1, kind: "reasoning", detail: "first" },
      { sequence: RUNNER_SEQUENCE_BASE + 2, kind: "command", detail: "second" },
    ], env.DB);

    const fromMember = await getRunEventsForMember(sessionId, runId, member.id, RUNNER_SEQUENCE_BASE + 1, env.DB);
    expect(fromMember?.map((event) => event.detail)).toEqual(["second"]);

    const outsider = await upsertUser(identity("read-auth-outsider", "Outsider"), env.DB);
    expect(await getRunEventsForMember(sessionId, runId, outsider.id, 0, env.DB)).toBeNull();

    const otherRoom = await room("read-auth-other");
    expect(await getRunEventsForMember(otherRoom.sessionId, runId, otherRoom.owner.id, 0, env.DB)).toEqual([]);
    expect(owner.id).toBeTruthy();
  });
});

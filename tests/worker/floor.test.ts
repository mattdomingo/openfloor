import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createFloorAgent,
  createFloorMessage,
  createFloorQueueItem,
  deleteFloorAgent,
  deleteFloorQueueItem,
  deprovisionIdleGeneratedAgents,
  ensureAnswerAgent,
  ensureWorkerAgent,
  FloorConflictError,
  FloorTargetError,
  GENERATED_AGENT_LINGER_MS,
  getFloorSnapshot,
  pauseAllFloorAgents,
  pauseFloorAgent,
  reorderFloorQueue,
  resumeAllFloorAgents,
  stopAllFloorAgents,
  stopFloorAgent,
  updateFloorAgentSettings,
  updateFloorAssignment,
} from "@/db/floor";
import { acceptInvite, createSession, endSession, SessionEndedError, upsertUser } from "@/db/sessions";
import { parseAgentInput } from "@/lib/validation";

function identity(id: string, name: string) {
  return { providerUserId: `floor-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function floorRoom(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const third = await upsertUser(identity(`${suffix}-third`, "Third Example"), env.DB);
  const outsider = await upsertUser(identity(`${suffix}-outsider`, "Outsider Example"), env.DB);
  const created = await createSession(owner.id, { title: `Floor ${suffix}`, objective: null }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  await acceptInvite(created.inviteId, third.id, env.DB);
  return { sessionId: created.session.id, owner, member, third, outsider };
}

function agentInput(ownerUserId: string, name = "Lumen") {
  const input = parseAgentInput({ name, role: "Researcher", task: "Map the API", ownerUserId });
  if (!input) throw new Error("Invalid test agent");
  return input;
}

/** Minimal scaffolding + an agent_runs row bound to an existing queue item at
    the given status — reproduces the exact shape that used to make
    deleteFloorQueueItem raise a FOREIGN KEY constraint failure
    (agent_runs.queue_item_id has no ON DELETE cascade), and doubles as the
    "this agent has an active run" fixture for the lifecycle tests below. */
async function insertRun(sessionId: string, agentId: string, userId: string, queueItemId: string, status = "failed"): Promise<string> {
  const now = Date.now();
  let candidate = await env.DB.prepare("SELECT id FROM repository_candidates WHERE session_id = ? AND status = 'active'")
    .bind(sessionId).first<{ id: string }>();
  if (!candidate) {
    const connectionId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
       VALUES (?, ?, 'inst', 'repo', 'node', 'owner', 'name', 'owner/name', 1, 'main', 'main', 'ready', ?, ?, ?)`,
    ).bind(connectionId, sessionId, userId, now, now).run();
    const candidateId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'candidate', 'main', 'sha-base', 'active', ?, ?, ?)`,
    ).bind(candidateId, sessionId, connectionId, userId, now, now).run();
    candidate = { id: candidateId };
  }
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sha-run', 1, ?, 'test-model', 'sandbox', ?, ?, ?)`,
  ).bind(runId, sessionId, queueItemId, agentId, candidate.id, status, userId, now, now).run();
  return runId;
}

describe("D1 persistent floor", () => {
  it("starts empty, derives blank assignments from members, and conceals outsiders", async () => {
    const room = await floorRoom("empty");
    const floor = await getFloorSnapshot(room.sessionId, room.owner.id, env.DB);
    expect(floor).toEqual(expect.objectContaining({ revision: 0, agents: [], queue: [], messages: [], repository: null, activeCandidate: null, latestPreflight: null, review: null }));
    expect(floor?.assignments).toEqual([
      expect.objectContaining({ userId: room.owner.id, task: null }),
      expect.objectContaining({ userId: room.member.id, task: null }),
      expect.objectContaining({ userId: room.third.id, task: null }),
    ]);
    await expect(getFloorSnapshot(room.sessionId, room.outsider.id, env.DB)).resolves.toBeNull();
  });

  it("persists uniquely named agents with real member ownership", async () => {
    const room = await floorRoom("agents");
    const floor = await createFloorAgent(room.sessionId, room.member.id, agentInput(room.owner.id), env.DB);
    expect(floor?.agents).toEqual([expect.objectContaining({ name: "Lumen", ownerUserId: room.owner.id, state: "created", provider: "openai", model: null, credentialKind: null })]);
    expect(floor?.revision).toBe(1);
    await expect(createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id, "LUMEN"), env.DB)).rejects.toBeInstanceOf(FloorConflictError);
    await expect(createFloorAgent(room.sessionId, room.owner.id, agentInput(room.outsider.id, "Other"), env.DB)).rejects.toBeInstanceOf(FloorTargetError);
    await expect(createFloorAgent(room.sessionId, room.outsider.id, agentInput(room.owner.id, "Hidden"), env.DB)).resolves.toBeNull();
  });

  it("sums lifetime cost across runs, flags a mixed cost source, and reports the most recent billed_kind", async () => {
    const room = await floorRoom("cost-aggregate");
    const floor = await createFloorAgent(room.sessionId, room.member.id, agentInput(room.owner.id), env.DB);
    const agentId = floor!.agents[0].id;
    const firstQueueFloor = await createFloorQueueItem(room.sessionId, room.member.id, { prompt: "Work 1", agentId }, env.DB);
    const firstQueueItemId = firstQueueFloor!.queue[0].id;

    // No priced run yet: null, not zero.
    const empty = await getFloorSnapshot(room.sessionId, room.owner.id, env.DB);
    expect(empty?.agents[0]).toEqual(expect.objectContaining({ costMicroUsd: null, costSource: null, billedKind: null }));

    const firstRunId = await insertRun(room.sessionId, agentId, room.owner.id, firstQueueItemId, "ready");
    await env.DB.prepare("UPDATE agent_runs SET cost_micro_usd = 10000, cost_source = 'reported', billed_kind = 'api_key', created_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, firstRunId).run();

    const afterFirst = await getFloorSnapshot(room.sessionId, room.owner.id, env.DB);
    expect(afterFirst?.agents[0]).toEqual(expect.objectContaining({ costMicroUsd: 10000, costSource: "reported", billedKind: "api_key" }));

    // A later run through kimi/glm (estimated) mixes the agent's history and
    // becomes the most recent billed_kind — even though it names a
    // DIFFERENT credential kind than the first run.
    const secondQueueFloor = await createFloorQueueItem(room.sessionId, room.member.id, { prompt: "Work 2", agentId }, env.DB);
    const secondQueueItemId = secondQueueFloor!.queue.find((item) => item.id !== firstQueueItemId)!.id;
    const secondRunId = await insertRun(room.sessionId, agentId, room.owner.id, secondQueueItemId, "ready");
    await env.DB.prepare("UPDATE agent_runs SET cost_micro_usd = 5000, cost_source = 'estimated', billed_kind = 'oauth', created_at = ? WHERE id = ?")
      .bind(Date.now(), secondRunId).run();

    const afterSecond = await getFloorSnapshot(room.sessionId, room.owner.id, env.DB);
    expect(afterSecond?.agents[0]).toEqual(expect.objectContaining({ costMicroUsd: 15000, costSource: "mixed", billedKind: "oauth" }));
  });

  it("persists a chosen provider and defaults the rest to openai", async () => {
    const room = await floorRoom("providers");
    const claudeInput = parseAgentInput({ name: "Claude", role: "Researcher", task: "Research", ownerUserId: room.owner.id, provider: "anthropic" });
    if (!claudeInput) throw new Error("Invalid test agent");
    const floor = await createFloorAgent(room.sessionId, room.owner.id, claudeInput, env.DB);
    expect(floor?.agents.find((agent) => agent.name === "Claude")?.provider).toBe("anthropic");
    const second = await createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id, "Codex"), env.DB);
    expect(second?.agents.find((agent) => agent.name === "Codex")?.provider).toBe("openai");
  });

  it("exposes an agent's stored billing choice and persists a chosen model", async () => {
    const room = await floorRoom("billing-visible");
    const input = parseAgentInput({ name: "Sub", role: "Researcher", task: "Research", ownerUserId: room.owner.id, provider: "anthropic", credentialKind: "oauth", model: "claude-sonnet-5" });
    if (!input) throw new Error("Invalid test agent");
    const floor = await createFloorAgent(room.sessionId, room.owner.id, input, env.DB);
    const agent = floor?.agents.find((candidate) => candidate.name === "Sub");
    expect(agent?.credentialKind).toBe("oauth");
    expect(agent?.model).toBe("claude-sonnet-5");
  });

  it("edits task, model, and billing on a persistent agent against its stored provider", async () => {
    const room = await floorRoom("agent-settings");
    const input = parseAgentInput({ name: "Edit", role: "Engineer", task: "Work", ownerUserId: room.owner.id, provider: "anthropic" });
    if (!input) throw new Error("Invalid test agent");
    const floor = await createFloorAgent(room.sessionId, room.owner.id, input, env.DB);
    const agentId = floor!.agents[0].id;
    let updated = await updateFloorAgentSettings(room.sessionId, room.member.id, agentId, { model: "claude-sonnet-5" }, env.DB);
    expect(updated?.agents[0].model).toBe("claude-sonnet-5");
    // The old task-only contract survives the generalization.
    updated = await updateFloorAgentSettings(room.sessionId, room.member.id, agentId, { task: "New task" }, env.DB);
    expect(updated?.agents[0].task).toBe("New task");
    expect(updated?.agents[0].model).toBe("claude-sonnet-5");
    // Explicit null resets to the provider default.
    updated = await updateFloorAgentSettings(room.sessionId, room.member.id, agentId, { model: null }, env.DB);
    expect(updated?.agents[0].model).toBeNull();
    // A model outside the STORED provider's allowlist is refused — no
    // provider crossed the wire, so a caller cannot pick which list applies.
    await expect(updateFloorAgentSettings(room.sessionId, room.owner.id, agentId, { model: "kimi-k3" }, env.DB)).rejects.toBeInstanceOf(FloorTargetError);
    // Same rule for a billing kind the stored provider does not accept.
    // (This used kimi until its Kimi Code plan kind became real on
    // 2026-08-26; glm remains api_key-only.)
    const glmInput = parseAgentInput({ name: "GlmEdit", role: "Engineer", task: "Work", ownerUserId: room.owner.id, provider: "glm" });
    if (!glmInput) throw new Error("Invalid test agent");
    const glmFloor = await createFloorAgent(room.sessionId, room.owner.id, glmInput, env.DB);
    const glmAgentId = glmFloor!.agents.find((agent) => agent.name === "GlmEdit")!.id;
    await expect(updateFloorAgentSettings(room.sessionId, room.owner.id, glmAgentId, { credentialKind: "oauth" }, env.DB)).rejects.toBeInstanceOf(FloorTargetError);
    // Outsider concealment and the system-managed refusal both hold.
    await expect(updateFloorAgentSettings(room.sessionId, room.outsider.id, agentId, { model: null }, env.DB)).resolves.toBeNull();
    const answer = await ensureAnswerAgent(room.sessionId, room.owner.id, "openai", env.DB);
    await expect(updateFloorAgentSettings(room.sessionId, room.owner.id, answer.id, { model: null }, env.DB)).rejects.toBeInstanceOf(FloorTargetError);
  });

  it("refuses a billing change while the agent has a run in flight, then accepts it", async () => {
    const room = await floorRoom("billing-edit");
    const input = parseAgentInput({ name: "Bill", role: "Engineer", task: "Work", ownerUserId: room.owner.id, provider: "anthropic" });
    if (!input) throw new Error("Invalid test agent");
    let floor = await createFloorAgent(room.sessionId, room.owner.id, input, env.DB);
    const agentId = floor!.agents[0].id;
    floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Work", agentId }, env.DB);
    const itemId = floor!.queue[0].id;
    const runId = await insertRun(room.sessionId, agentId, room.owner.id, itemId, "running");
    // The gateway resolves credential_kind live on every proxied request, so
    // an in-flight run would bill the new payer mid-run — refuse instead.
    await expect(updateFloorAgentSettings(room.sessionId, room.owner.id, agentId, { credentialKind: "oauth" }, env.DB)).rejects.toBeInstanceOf(FloorConflictError);
    // A model edit during the same run is fine: the run's model was frozen
    // into agent_runs.model at creation and cannot be disturbed.
    const during = await updateFloorAgentSettings(room.sessionId, room.owner.id, agentId, { model: "claude-sonnet-5" }, env.DB);
    expect(during?.agents[0].model).toBe("claude-sonnet-5");
    await env.DB.prepare("UPDATE agent_runs SET status = 'ready' WHERE id = ?").bind(runId).run();
    const after = await updateFloorAgentSettings(room.sessionId, room.owner.id, agentId, { credentialKind: "oauth" }, env.DB);
    expect(after?.agents[0].credentialKind).toBe("oauth");
    const reset = await updateFloorAgentSettings(room.sessionId, room.owner.id, agentId, { credentialKind: null }, env.DB);
    expect(reset?.agents[0].credentialKind).toBeNull();
  });

  it("persists unassigned and targeted prompts and ordering", async () => {
    const room = await floorRoom("queue");
    let floor = await createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id), env.DB);
    const agentId = floor!.agents[0].id;
    floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Unassigned", agentId: null }, env.DB);
    floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "First targeted", agentId }, env.DB);
    floor = await createFloorQueueItem(room.sessionId, room.member.id, { prompt: "Second targeted", agentId }, env.DB);
    expect(floor!.queue.map((item) => item.agentId)).toEqual([null, agentId, agentId]);

    const reversed = [...floor!.queue].reverse().map((item) => item.id);
    floor = await reorderFloorQueue(room.sessionId, room.member.id, reversed, env.DB);
    expect(floor!.queue.map((item) => item.id)).toEqual(reversed);

    await expect(createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Wrong target", agentId: "missing" }, env.DB)).rejects.toBeInstanceOf(FloorTargetError);
  });

  it("soft-deletes a failed prompt that still has an agent_runs row, preserving the run", async () => {
    const room = await floorRoom("delete-failed");
    let floor = await createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id), env.DB);
    const agentId = floor!.agents[0].id;
    floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Will fail", agentId }, env.DB);
    const failedItemId = floor!.queue[0].id;
    floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Stays queued", agentId }, env.DB);
    const survivingItemId = floor!.queue.find((item) => item.id !== failedItemId)!.id;
    await env.DB.prepare("UPDATE floor_queue_items SET status = 'failed' WHERE id = ?").bind(failedItemId).run();
    const runId = await insertRun(room.sessionId, agentId, room.owner.id, failedItemId, "failed");

    // Before the fix this raised a raw FOREIGN KEY constraint failure — an
    // unhandled error that usePersistentFloorData's client misreported as
    // "The floor could not be reached."
    floor = await deleteFloorQueueItem(room.sessionId, room.owner.id, failedItemId, env.DB);
    expect(floor).not.toBeNull();
    expect(floor!.queue.map((item) => item.id)).toEqual([survivingItemId]);
    expect(floor!.queue[0].position).toBe(1);

    const run = await env.DB.prepare("SELECT id, status FROM agent_runs WHERE id = ?").bind(runId).first<{ id: string; status: string }>();
    expect(run).toEqual({ id: runId, status: "failed" });

    await expect(deleteFloorQueueItem(room.sessionId, room.owner.id, failedItemId, env.DB)).rejects.toBeInstanceOf(FloorConflictError);
  });

  it("persists assignments and protects direct messages from other members", async () => {
    const room = await floorRoom("messages");
    let floor = await updateFloorAssignment(room.sessionId, room.member.id, room.owner.id, { task: "Own the release" }, env.DB);
    expect(floor?.assignments.find((assignment) => assignment.userId === room.owner.id)?.task).toBe("Own the release");
    floor = await createFloorMessage(room.sessionId, room.owner.id, { text: "Team update", recipientUserId: null }, env.DB);
    floor = await createFloorMessage(room.sessionId, room.owner.id, { text: "Private update", recipientUserId: room.member.id }, env.DB);
    expect(floor?.messages.map((message) => message.text)).toEqual(["Team update", "Private update"]);
    const memberFloor = await getFloorSnapshot(room.sessionId, room.member.id, env.DB);
    expect(memberFloor?.messages.map((message) => message.text)).toEqual(["Team update", "Private update"]);
    const thirdFloor = await getFloorSnapshot(room.sessionId, room.third.id, env.DB);
    expect(thirdFloor?.messages.map((message) => message.text)).toEqual(["Team update"]);
    await expect(createFloorMessage(room.sessionId, room.owner.id, { text: "Bad DM", recipientUserId: room.outsider.id }, env.DB)).rejects.toBeInstanceOf(FloorTargetError);
  });

  it("pauses and resumes persistent agents and generated workers for any member, but refuses Concierge", async () => {
    const room = await floorRoom("pause");
    let floor = await createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id), env.DB);
    const agentId = floor!.agents[0].id;
    const answer = await ensureAnswerAgent(room.sessionId, room.owner.id, "openai", env.DB);
    const worker = await ensureWorkerAgent(room.sessionId, room.owner.id, "openai", "Generated work", env.DB);

    floor = await pauseFloorAgent(room.sessionId, room.member.id, agentId, true, env.DB);
    expect(floor!.agents.find((agent) => agent.id === agentId)?.pausedAt).not.toBeNull();
    await expect(pauseFloorAgent(room.sessionId, room.owner.id, agentId, true, env.DB)).rejects.toBeInstanceOf(FloorConflictError);

    floor = await pauseFloorAgent(room.sessionId, room.owner.id, agentId, false, env.DB);
    expect(floor!.agents.find((agent) => agent.id === agentId)?.pausedAt).toBeNull();
    await expect(pauseFloorAgent(room.sessionId, room.member.id, agentId, false, env.DB)).rejects.toBeInstanceOf(FloorConflictError);

    await expect(pauseFloorAgent(room.sessionId, room.owner.id, answer.id, true, env.DB)).rejects.toBeInstanceOf(FloorConflictError);
    floor = await pauseFloorAgent(room.sessionId, room.member.id, worker.id, true, env.DB);
    expect(floor!.agents.find((agent) => agent.id === worker.id)?.pausedAt).not.toBeNull();
    floor = await pauseFloorAgent(room.sessionId, room.owner.id, worker.id, false, env.DB);
    expect(floor!.agents.find((agent) => agent.id === worker.id)?.pausedAt).toBeNull();
    await expect(pauseFloorAgent(room.sessionId, room.outsider.id, agentId, true, env.DB)).resolves.toBeNull();

    await endSession(room.sessionId, room.owner.id, "owner", env.DB);
    await expect(pauseFloorAgent(room.sessionId, room.owner.id, agentId, true, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
  });

  it("stops an agent: always blocks new dispatch, but only an owner caller cancels its active run", async () => {
    const memberStopRoom = await floorRoom("stop-member");
    let floor = await createFloorAgent(memberStopRoom.sessionId, memberStopRoom.owner.id, agentInput(memberStopRoom.owner.id), env.DB);
    const memberAgentId = floor!.agents[0].id;
    floor = await createFloorQueueItem(memberStopRoom.sessionId, memberStopRoom.owner.id, { prompt: "Do work", agentId: memberAgentId }, env.DB);
    const memberItemId = floor!.queue[0].id;
    const memberRunId = await insertRun(memberStopRoom.sessionId, memberAgentId, memberStopRoom.owner.id, memberItemId, "running");

    floor = await stopFloorAgent(memberStopRoom.sessionId, memberStopRoom.member.id, memberAgentId, env.DB);
    expect(floor!.agents.find((agent) => agent.id === memberAgentId)?.pausedAt).not.toBeNull();
    const untouchedRun = await env.DB.prepare("SELECT status FROM agent_runs WHERE id = ?").bind(memberRunId).first<{ status: string }>();
    expect(untouchedRun?.status).toBe("running");

    const ownerStopRoom = await floorRoom("stop-owner");
    floor = await createFloorAgent(ownerStopRoom.sessionId, ownerStopRoom.owner.id, agentInput(ownerStopRoom.owner.id), env.DB);
    const ownerAgentId = floor!.agents[0].id;
    floor = await createFloorQueueItem(ownerStopRoom.sessionId, ownerStopRoom.owner.id, { prompt: "Do work", agentId: ownerAgentId }, env.DB);
    const ownerItemId = floor!.queue[0].id;
    const ownerRunId = await insertRun(ownerStopRoom.sessionId, ownerAgentId, ownerStopRoom.owner.id, ownerItemId, "running");

    floor = await stopFloorAgent(ownerStopRoom.sessionId, ownerStopRoom.owner.id, ownerAgentId, env.DB);
    expect(floor!.agents.find((agent) => agent.id === ownerAgentId)?.pausedAt).not.toBeNull();
    const cancelledRun = await env.DB.prepare("SELECT status FROM agent_runs WHERE id = ?").bind(ownerRunId).first<{ status: string }>();
    expect(cancelledRun?.status).toBe("cancel_requested");

    const answer = await ensureAnswerAgent(ownerStopRoom.sessionId, ownerStopRoom.owner.id, "openai", env.DB);
    await expect(stopFloorAgent(ownerStopRoom.sessionId, ownerStopRoom.owner.id, answer.id, env.DB)).rejects.toBeInstanceOf(FloorTargetError);
    await expect(stopFloorAgent(ownerStopRoom.sessionId, ownerStopRoom.outsider.id, ownerAgentId, env.DB)).resolves.toBeNull();
  });

  it("applies worker Stop cancellation authorization and preserves paused workers until Auto agents is disabled", async () => {
    const memberRoom = await floorRoom("worker-stop-member");
    const memberWorker = await ensureWorkerAgent(memberRoom.sessionId, memberRoom.owner.id, "openai", "Generated work", env.DB);
    let floor = await createFloorQueueItem(memberRoom.sessionId, memberRoom.owner.id, { prompt: "Do work", agentId: memberWorker.id }, env.DB);
    const memberRunId = await insertRun(memberRoom.sessionId, memberWorker.id, memberRoom.owner.id, floor!.queue[0].id, "running");
    floor = await stopFloorAgent(memberRoom.sessionId, memberRoom.member.id, memberWorker.id, env.DB);
    expect(floor!.agents.find((agent) => agent.id === memberWorker.id)?.pausedAt).not.toBeNull();
    expect((await env.DB.prepare("SELECT status FROM agent_runs WHERE id = ?").bind(memberRunId).first<{ status: string }>())?.status).toBe("running");

    const ownerRoom = await floorRoom("worker-stop-owner");
    const ownerWorker = await ensureWorkerAgent(ownerRoom.sessionId, ownerRoom.owner.id, "openai", "Generated work", env.DB);
    floor = await createFloorQueueItem(ownerRoom.sessionId, ownerRoom.owner.id, { prompt: "Do work", agentId: ownerWorker.id }, env.DB);
    const ownerRunId = await insertRun(ownerRoom.sessionId, ownerWorker.id, ownerRoom.owner.id, floor!.queue[0].id, "running");
    await stopFloorAgent(ownerRoom.sessionId, ownerRoom.owner.id, ownerWorker.id, env.DB);
    expect((await env.DB.prepare("SELECT status FROM agent_runs WHERE id = ?").bind(ownerRunId).first<{ status: string }>())?.status).toBe("cancel_requested");

    await env.DB.prepare("UPDATE agent_runs SET status = 'cancelled' WHERE id = ?").bind(ownerRunId).run();
    await env.DB.prepare("UPDATE floor_queue_items SET status = 'cancelled' WHERE session_id = ?").bind(ownerRoom.sessionId).run();
    await deprovisionIdleGeneratedAgents(ownerRoom.sessionId, true, env.DB);
    const readWorker = () => env.DB.prepare("SELECT paused_at AS pausedAt, deprovisioned_at AS deprovisionedAt, idle_since AS idleSince FROM floor_agents WHERE id = ?")
      .bind(ownerWorker.id).first<{ pausedAt: number | null; deprovisionedAt: number | null; idleSince: number | null }>();
    let stored = await readWorker();
    expect(stored?.pausedAt).not.toBeNull();
    expect(stored?.deprovisionedAt).toBeNull();
    // Retirement lingers ~GENERATED_AGENT_LINGER_MS after a row first goes
    // idle (see db/floor.ts) rather than firing on the very next tick, so a
    // reply's speech bubble is never yanked off the floor mid-read. The
    // first call only starts the grace clock; retirement needs a `now` that
    // has actually cleared the window.
    const idleAt = Date.now();
    let outcome = await deprovisionIdleGeneratedAgents(ownerRoom.sessionId, false, env.DB, idleAt);
    expect(outcome.nextRetireAt).toBe(idleAt + GENERATED_AGENT_LINGER_MS);
    stored = await readWorker();
    expect(stored?.pausedAt).toBeNull();
    expect(stored?.deprovisionedAt).toBeNull();
    expect(stored?.idleSince).toBe(idleAt);
    outcome = await deprovisionIdleGeneratedAgents(ownerRoom.sessionId, false, env.DB, idleAt + GENERATED_AGENT_LINGER_MS + 1);
    expect(outcome.changed).toBe(true);
    stored = await readWorker();
    expect(stored?.pausedAt).toBeNull();
    expect(stored?.deprovisionedAt).not.toBeNull();
  });

  it("deletes an idle persistent agent and unassigns its queued items; refuses while a run is active or on a system-managed agent", async () => {
    const room = await floorRoom("delete-agent");
    let floor = await createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id), env.DB);
    const agentId = floor!.agents[0].id;
    floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Queued for this agent", agentId }, env.DB);
    const queuedItemId = floor!.queue[0].id;
    const runId = await insertRun(room.sessionId, agentId, room.owner.id, queuedItemId, "running");

    await expect(deleteFloorAgent(room.sessionId, room.member.id, agentId, env.DB)).rejects.toBeInstanceOf(FloorConflictError);

    await env.DB.prepare("UPDATE agent_runs SET status = 'cancelled' WHERE id = ?").bind(runId).run();
    floor = await deleteFloorAgent(room.sessionId, room.member.id, agentId, env.DB);
    expect(floor!.agents.find((agent) => agent.id === agentId)).toBeUndefined();
    const item = await env.DB.prepare("SELECT agent_id AS agentId FROM floor_queue_items WHERE id = ?").bind(queuedItemId).first<{ agentId: string | null }>();
    expect(item?.agentId).toBeNull();

    await expect(deleteFloorAgent(room.sessionId, room.owner.id, agentId, env.DB)).rejects.toBeInstanceOf(FloorConflictError);
    const answer = await ensureAnswerAgent(room.sessionId, room.owner.id, "openai", env.DB);
    const worker = await ensureWorkerAgent(room.sessionId, room.owner.id, "openai", "Generated work", env.DB);
    await expect(deleteFloorAgent(room.sessionId, room.owner.id, answer.id, env.DB)).rejects.toBeInstanceOf(FloorConflictError);
    await expect(deleteFloorAgent(room.sessionId, room.owner.id, worker.id, env.DB)).rejects.toBeInstanceOf(FloorConflictError);
    await expect(deleteFloorAgent(room.sessionId, room.outsider.id, agentId, env.DB)).resolves.toBeNull();
  });

  it("bulk pause/resume/stop are owner-only, include workers, and exclude Concierge", async () => {
    const room = await floorRoom("bulk");
    let floor = await createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id, "First"), env.DB);
    const firstId = floor!.agents[0].id;
    floor = await createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id, "Second"), env.DB);
    const secondId = floor!.agents.find((agent) => agent.name === "Second")!.id;
    const answer = await ensureAnswerAgent(room.sessionId, room.owner.id, "openai", env.DB);
    const worker = await ensureWorkerAgent(room.sessionId, room.owner.id, "openai", "Generated work", env.DB);

    await expect(pauseAllFloorAgents(room.sessionId, room.member.id, env.DB)).resolves.toBeNull();

    floor = await pauseAllFloorAgents(room.sessionId, room.owner.id, env.DB);
    expect(floor!.agents.find((agent) => agent.id === firstId)?.pausedAt).not.toBeNull();
    expect(floor!.agents.find((agent) => agent.id === secondId)?.pausedAt).not.toBeNull();
    expect(floor!.agents.find((agent) => agent.id === answer.id)?.pausedAt).toBeNull();
    expect(floor!.agents.find((agent) => agent.id === worker.id)?.pausedAt).not.toBeNull();

    floor = await resumeAllFloorAgents(room.sessionId, room.owner.id, env.DB);
    expect(floor!.agents.find((agent) => agent.id === firstId)?.pausedAt).toBeNull();
    expect(floor!.agents.find((agent) => agent.id === secondId)?.pausedAt).toBeNull();
    expect(floor!.agents.find((agent) => agent.id === worker.id)?.pausedAt).toBeNull();

    floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Active work", agentId: firstId }, env.DB);
    const activeItemId = floor!.queue.find((item) => item.agentId === firstId)!.id;
    const runId = await insertRun(room.sessionId, firstId, room.owner.id, activeItemId, "running");
    floor = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Generated active work", agentId: worker.id }, env.DB);
    const workerItemId = floor!.queue.find((item) => item.agentId === worker.id)!.id;
    const workerRunId = await insertRun(room.sessionId, worker.id, room.owner.id, workerItemId, "running");

    floor = await stopAllFloorAgents(room.sessionId, room.owner.id, env.DB);
    expect(floor!.agents.find((agent) => agent.id === firstId)?.pausedAt).not.toBeNull();
    expect(floor!.agents.find((agent) => agent.id === secondId)?.pausedAt).not.toBeNull();
    const run = await env.DB.prepare("SELECT status FROM agent_runs WHERE id = ?").bind(runId).first<{ status: string }>();
    expect(run?.status).toBe("cancel_requested");
    const workerRun = await env.DB.prepare("SELECT status FROM agent_runs WHERE id = ?").bind(workerRunId).first<{ status: string }>();
    expect(workerRun?.status).toBe("cancel_requested");
  });

  it("builds review files from GitHub pull request review data when populated", async () => {
    const room = await floorRoom("review-data");
    const connectionId = crypto.randomUUID();
    const candidateId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
       VALUES (?, ?, 'inst-rev', 'repo-rev', 'node-rev', 'openfloor', 'test-repo', 'openfloor/test-repo', 1, 'main', 'main', 'ready', ?, ?, ?)`
    ).bind(connectionId, room.sessionId, room.owner.id, now, now).run();
    await env.DB.prepare(
      `INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, status, pull_request_number, pull_request_url, pull_request_state, pull_request_draft, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'openfloor/candidate', 'main', 'sha-base', 'active', 42, 'https://github.com/openfloor/test-repo/pull/42', 'open', 1, ?, ?, ?)`
    ).bind(candidateId, room.sessionId, connectionId, room.owner.id, now, now).run();
    await env.DB.prepare(
      `INSERT INTO repository_candidate_files (id, candidate_id, path, additions, deletions, change_kind, patch_preview)
       VALUES (?, ?, 'src/index.ts', 10, 2, 'modified', '+const x = 1;\n-const x = 0;')`
    ).bind(crypto.randomUUID(), candidateId).run();

    const snapshot = await getFloorSnapshot(room.sessionId, room.owner.id, env.DB);
    expect(snapshot?.review).not.toBeNull();
    expect(snapshot?.review?.files).toEqual([
      expect.objectContaining({
        path: "src/index.ts",
        additions: 10,
        deletions: 2,
        summary: "GitHub pull request diff",
      }),
    ]);
  });
});

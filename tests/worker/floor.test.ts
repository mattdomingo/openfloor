import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createFloorAgent,
  createFloorMessage,
  createFloorQueueItem,
  deleteFloorQueueItem,
  FloorConflictError,
  FloorTargetError,
  getFloorSnapshot,
  reorderFloorQueue,
  updateFloorAssignment,
} from "@/db/floor";
import { acceptInvite, createSession, upsertUser } from "@/db/sessions";
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

/** Minimal scaffolding + a 'failed' agent_runs row bound to an existing queue
    item — reproduces the exact shape that used to make deleteFloorQueueItem
    raise a FOREIGN KEY constraint failure (agent_runs.queue_item_id has no
    ON DELETE cascade). */
async function insertFailedRun(sessionId: string, agentId: string, userId: string, queueItemId: string): Promise<string> {
  const now = Date.now();
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
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sha-run', 1, 'failed', 'test-model', 'sandbox', ?, ?, ?)`,
  ).bind(runId, sessionId, queueItemId, agentId, candidateId, userId, now, now).run();
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
    expect(floor?.agents).toEqual([expect.objectContaining({ name: "Lumen", ownerUserId: room.owner.id, state: "created", provider: "openai", model: null })]);
    expect(floor?.revision).toBe(1);
    await expect(createFloorAgent(room.sessionId, room.owner.id, agentInput(room.owner.id, "LUMEN"), env.DB)).rejects.toBeInstanceOf(FloorConflictError);
    await expect(createFloorAgent(room.sessionId, room.owner.id, agentInput(room.outsider.id, "Other"), env.DB)).rejects.toBeInstanceOf(FloorTargetError);
    await expect(createFloorAgent(room.sessionId, room.outsider.id, agentInput(room.owner.id, "Hidden"), env.DB)).resolves.toBeNull();
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
    const runId = await insertFailedRun(room.sessionId, agentId, room.owner.id, failedItemId);

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
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createFloorAgent,
  createFloorMessage,
  createFloorQueueItem,
  FloorConflictError,
  FloorTargetError,
  getFloorSnapshot,
  mergeFloorQueue,
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

  it("persists unassigned and targeted prompts, ordering, and merge authorship", async () => {
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

    const targetedIds = floor!.queue.filter((item) => item.agentId === agentId).map((item) => item.id);
    floor = await mergeFloorQueue(room.sessionId, room.owner.id, targetedIds, env.DB);
    const merged = floor!.queue.find((item) => item.agentId === agentId);
    expect(merged?.prompts.map((prompt) => ({ author: prompt.authorUserId, text: prompt.text }))).toEqual(expect.arrayContaining([
      { author: room.owner.id, text: "First targeted" },
      { author: room.member.id, text: "Second targeted" },
    ]));
    expect(floor!.queue).toHaveLength(2);
    await expect(createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Wrong target", agentId: "missing" }, env.DB)).rejects.toBeInstanceOf(FloorTargetError);
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

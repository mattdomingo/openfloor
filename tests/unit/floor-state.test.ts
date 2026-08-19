import { describe, expect, it } from "vitest";
import { floorParticipants } from "@/components/session/usePersistentFloorData";
import { firstMergeableQueueGroup, resolvePersistedAgentMention, shouldRefreshFloor } from "@/lib/floor-state";
import type { AppUser, SessionMember } from "@/lib/session-types";
import type { FloorAgent, FloorQueueItem } from "@/lib/floor-types";

const user = { id: "owner", displayName: "Owner Example" } as AppUser;
const members: SessionMember[] = [
  { id: "owner", displayName: "Owner Example", role: "owner", joinedAt: 1, online: true },
  { id: "member", displayName: "Member Example", role: "member", joinedAt: 2, online: false },
];
const agent = { id: "agent", name: "Lumen" } as FloorAgent;
const queue = (id: string, agentId: string | null, status: FloorQueueItem["status"] = "queued"): FloorQueueItem => ({ id, agentId, status, prompts: [] } as unknown as FloorQueueItem);

describe("persistent floor state", () => {
  it("derives participants only from real members", () => {
    expect(floorParticipants(members, user)).toEqual([
      expect.objectContaining({ id: "owner", name: "Owner Example", online: true, isCurrentUser: true }),
      expect.objectContaining({ id: "member", name: "Member Example", online: false, isCurrentUser: false }),
    ]);
  });

  it("resolves exact persisted mentions and otherwise leaves prompts unassigned", () => {
    expect(resolvePersistedAgentMention("Please ask @Lumen", [agent])).toBe(agent);
    expect(resolvePersistedAgentMention("Please ask @Missing", [agent])).toBeNull();
  });

  it("merges only adjacent queue items with the same nullable target", () => {
    expect(firstMergeableQueueGroup([queue("one", null), queue("two", null), queue("three", "agent")])).toEqual(["one", "two"]);
    expect(firstMergeableQueueGroup([queue("one", null), queue("two", "agent")])).toEqual([]);
    expect(firstMergeableQueueGroup([queue("one", null), queue("blocked", null, "blocked"), queue("two", null)])).toEqual([]);
  });

  it("refreshes only for newer floor revisions", () => {
    expect(shouldRefreshFloor(2, { type: "floor.changed", revision: 3, domains: ["agents"] })).toBe(true);
    expect(shouldRefreshFloor(3, { type: "floor.changed", revision: 3, domains: ["agents"] })).toBe(false);
  });
});

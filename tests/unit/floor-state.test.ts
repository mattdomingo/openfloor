import { describe, expect, it } from "vitest";
import { floorParticipants } from "@/components/session/usePersistentFloorData";
import { countMessagesSinceObjective, resolvePersistedAgentMention, shouldRefreshFloor } from "@/lib/floor-state";
import type { AppUser, SessionMember } from "@/lib/session-types";
import type { FloorAgent, FloorMessage } from "@/lib/floor-types";

const user = { id: "owner", displayName: "Owner Example" } as AppUser;
const members: SessionMember[] = [
  { id: "owner", displayName: "Owner Example", role: "owner", joinedAt: 1, online: true },
  { id: "member", displayName: "Member Example", role: "member", joinedAt: 2, online: false },
];
const agent = { id: "agent", name: "Lumen" } as FloorAgent;

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

  it("refreshes only for newer floor revisions", () => {
    expect(shouldRefreshFloor(2, { type: "floor.changed", revision: 3, domains: ["agents"] })).toBe(true);
    expect(shouldRefreshFloor(3, { type: "floor.changed", revision: 3, domains: ["agents"] })).toBe(false);
  });

  it("counts only public messages newer than the objective's last edit, never direct messages", () => {
    const message = (id: string, createdAt: number, recipientUserId: string | null = null): FloorMessage =>
      ({ id, authorUserId: "member", recipientUserId, text: `msg ${id}`, createdAt }) as FloorMessage;
    const messages = [
      message("before", 100),
      message("after-1", 200),
      message("after-2", 300),
      message("dm-after", 400, "owner"),
    ];
    expect(countMessagesSinceObjective(messages, 150)).toBe(2);
    expect(countMessagesSinceObjective(messages, 300)).toBe(0);
    expect(countMessagesSinceObjective(messages, 0)).toBe(3);
  });
});

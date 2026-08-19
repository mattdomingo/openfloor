import { describe, expect, it } from "vitest";
import { createPrototypeFloorSeed, floorParticipants } from "@/components/session/usePrototypeFloorData";
import type { SessionMember } from "@/lib/session-types";

const members: SessionMember[] = [
  { id: "owner", displayName: "Owner Example", role: "owner", joinedAt: 1, online: true },
  { id: "member", displayName: "Member Example", role: "member", joinedAt: 2, online: false },
];

describe("prototype floor data source", () => {
  it("derives participants and ownership from real session members", () => {
    expect(floorParticipants(members, "owner")).toEqual([
      expect.objectContaining({ id: "owner", name: "Owner Example", initials: "OE", online: true, isCurrentUser: true }),
      expect.objectContaining({ id: "member", name: "Member Example", initials: "ME", online: false, isCurrentUser: false }),
    ]);
    const seed = createPrototypeFloorSeed(members, "owner");
    expect(seed.assignments.map((assignment) => assignment.name)).toEqual(["Owner Example", "Member Example"]);
    expect(seed.agents.map((agent) => agent.owner)).toContain("Owner Example");
    expect(seed.agents.map((agent) => agent.owner)).toContain("Member Example");
  });

  it("is deterministic for the same membership snapshot", () => {
    expect(createPrototypeFloorSeed(members, "owner")).toEqual(createPrototypeFloorSeed(members, "owner"));
  });
});

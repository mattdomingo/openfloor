import { describe, expect, it } from "vitest";
import { reducePresence } from "@/lib/presence";

describe("presence event reduction", () => {
  it("replaces state from a snapshot", () => {
    expect([...reducePresence(new Set(["old"]), { type: "presence.snapshot", onlineUserIds: ["one", "two"] })]).toEqual(["one", "two"]);
  });

  it("adds and removes individual users", () => {
    const online = reducePresence(new Set(["one"]), { type: "presence.changed", userId: "two", online: true });
    expect([...online]).toEqual(["one", "two"]);
    expect([...reducePresence(online, { type: "presence.changed", userId: "one", online: false })]).toEqual(["two"]);
  });

  it("preserves presence for membership, session, and error events", () => {
    expect([...reducePresence(new Set(["one"]), { type: "members.changed" })]).toEqual(["one"]);
    expect([...reducePresence(new Set(["one"]), { type: "session.changed", objective: "Next", updatedAt: 10 })]).toEqual(["one"]);
    expect([...reducePresence(new Set(["one"]), { type: "error", code: "nope" })]).toEqual(["one"]);
  });
});

import { describe, expect, it } from "vitest";
import { reduceTypingDrafts, visibleTypingDrafts } from "@/lib/typing-drafts";
import type { TypingDraft } from "@/lib/session-types";

const draft: TypingDraft = {
  userId: "member-one",
  displayName: "Member One",
  text: "A live prompt",
  typing: true,
  updatedAt: 10,
};

describe("typing draft reduction", () => {
  it("replaces drafts from a presence snapshot and applies changes", () => {
    const snapshot = reduceTypingDrafts(new Map(), {
      type: "presence.snapshot",
      onlineUserIds: ["member-one"],
      typingDrafts: [draft],
    });
    expect(snapshot.get("member-one")).toEqual(draft);

    const idle = reduceTypingDrafts(snapshot, { type: "typing.changed", draft: { ...draft, typing: false, updatedAt: 11 } });
    expect(idle.get("member-one")?.typing).toBe(false);
    const cleared = reduceTypingDrafts(idle, { type: "typing.changed", draft: { ...draft, text: "", typing: false, updatedAt: 12 } });
    expect(cleared.has("member-one")).toBe(false);
  });

  it("supports everyone, active-only, and hidden visibility", () => {
    const teammates = [{ id: "member-one", name: "One" }, { id: "member-two", name: "Two" }];
    const drafts = new Map([[draft.userId, draft]]);
    expect(visibleTypingDrafts(teammates, drafts, "all")).toHaveLength(2);
    expect(visibleTypingDrafts(teammates, drafts, "typing").map((person) => person.id)).toEqual(["member-one"]);
    expect(visibleTypingDrafts(teammates, drafts, "hidden")).toEqual([]);
  });
});

import { expect, it } from "vitest";
import { findMentionQuery } from "@/components/session/MentionComposer";
it("opens on bare @ and keeps filtering, without matching email addresses", () => {
  expect(findMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  expect(findMentionQuery("Ask @Lu", 7)).toEqual({ start: 4, query: "Lu" });
  expect(findMentionQuery("a@b", 3)).toBeNull();
});

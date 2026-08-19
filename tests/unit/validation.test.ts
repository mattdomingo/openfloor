import { describe, expect, it } from "vitest";
import { parseSessionInput } from "@/lib/validation";

describe("session input validation", () => {
  it("normalizes valid input", () => {
    expect(parseSessionInput({ title: "  Launch room ", objective: " Ship it " })).toEqual({
      title: "Launch room",
      objective: "Ship it",
    });
    expect(parseSessionInput({ title: "Launch room" })).toEqual({ title: "Launch room", objective: null });
  });

  it("rejects missing, empty, and oversized values", () => {
    expect(parseSessionInput(null)).toBeNull();
    expect(parseSessionInput({ title: "  " })).toBeNull();
    expect(parseSessionInput({ title: "x".repeat(101) })).toBeNull();
    expect(parseSessionInput({ title: "Room", objective: "x".repeat(2001) })).toBeNull();
  });
});

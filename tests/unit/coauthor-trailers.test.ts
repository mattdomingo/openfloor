import { describe, expect, it } from "vitest";
import { coauthorTrailers } from "@/lib/github";

describe("coauthorTrailers", () => {
  it("credits every member once, in order", () => {
    expect(coauthorTrailers([
      { displayName: "Ada Lovelace", email: "ada@example.com" },
      { displayName: "Grace Hopper", email: "grace@example.com" },
      { displayName: "Ada Again", email: "ada@example.com" },
    ])).toBe("Co-authored-by: Ada Lovelace <ada@example.com>\nCo-authored-by: Grace Hopper <grace@example.com>");
  });

  it("flattens a name that would break the trailer line", () => {
    expect(coauthorTrailers([{ displayName: "A <b>\nc", email: "a@example.com" }]))
      .toBe("Co-authored-by: A b c <a@example.com>");
  });

  it("falls back to the email when the name is empty and returns null with nobody to credit", () => {
    expect(coauthorTrailers([{ displayName: "  ", email: "a@example.com" }]))
      .toBe("Co-authored-by: a@example.com <a@example.com>");
    expect(coauthorTrailers([])).toBeNull();
    expect(coauthorTrailers([{ displayName: "x", email: "  " }])).toBeNull();
  });
});

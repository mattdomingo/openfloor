import { describe, expect, it } from "vitest";
import { displayNameFrom, initials, initialsFromParts } from "@/lib/display-name";

describe("displayNameFrom", () => {
  it("formats as \"First L.\"", () => {
    expect(displayNameFrom("Matt", "Domingo")).toBe("Matt D.");
  });

  it("still appends a bare period when lastName is empty", () => {
    expect(displayNameFrom("Matt", "")).toBe("Matt .");
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words, uppercased", () => {
    expect(initials("Matt Domingo")).toBe("MD");
  });

  it("handles a single-word name", () => {
    expect(initials("Matt")).toBe("M");
  });

  it("ignores extra whitespace between words", () => {
    expect(initials("Matt   Domingo")).toBe("MD");
  });

  it("falls back to \"?\" for an empty name", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });

  it("only ever uses the first two words even with a longer name", () => {
    expect(initials("Matt G Domingo")).toBe("MG");
  });
});

describe("initialsFromParts", () => {
  it("combines the first letter of each part, uppercased", () => {
    expect(initialsFromParts("matt", "domingo")).toBe("MD");
  });

  it("falls back to \"?\" for firstName but shows nothing for an empty lastName", () => {
    expect(initialsFromParts("", "")).toBe("?");
    expect(initialsFromParts("", "Domingo")).toBe("?D");
    expect(initialsFromParts("Matt", "")).toBe("M");
  });
});

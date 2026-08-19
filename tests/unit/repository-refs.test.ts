import { describe, expect, it } from "vitest";
import { openFloorBranchName } from "@/lib/repository-refs";

describe("OpenFloor repository refs", () => {
  it("derives candidate and run refs only from durable IDs", () => {
    expect(openFloorBranchName("12345678-abcd-4000-8000-123456789abc", "candidate", "abcdef12-1111-4000-8000-123456789abc"))
      .toBe("openfloor/12345678/candidate/abcdef12");
    expect(openFloorBranchName("12345678-abcd-4000-8000-123456789abc", "candidate", "abcdef12-1111-4000-8000-123456789abc", "Release Coordination"))
      .toBe("openfloor/12345678/candidate/release-coordination-abcdef12");
    expect(openFloorBranchName("12345678-abcd-4000-8000-123456789abc", "candidate", "abcdef12-1111-4000-8000-123456789abc", "🚀"))
      .toBe("openfloor/12345678/candidate/candidate-abcdef12");
    expect(openFloorBranchName("12345678-abcd-4000-8000-123456789abc", "run", "fedcba98-1111-4000-8000-123456789abc"))
      .toBe("openfloor/12345678/run/fedcba98");
  });

  it("rejects IDs that cannot produce a safe server ref", () => {
    expect(() => openFloorBranchName("short", "candidate", "abcdef12")).toThrow();
  });
});

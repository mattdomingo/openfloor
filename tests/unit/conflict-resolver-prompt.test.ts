import { describe, expect, it } from "vitest";
import { renderConflictResolverPrompt } from "@/lib/conflict-resolver-prompt";
import type { MergeConflictCase } from "@/lib/floor-types";

describe("Merge Resolver prompt", () => {
  it("renders real paths, human answers, source intent, and full session brief", () => {
    const conflict: MergeConflictCase = {
      id: "case-1", status: "pending", sourceRunId: "source-1", latestSourceRunId: "source-2", currentResolverRunId: null,
      queueItemId: "queue-1", agentId: "agent-1", agentName: "Lumen", conflictReason: "GitHub returned 409",
      explanation: "Need compatibility policy", conflictPaths: ["src/api.ts", "src/types.ts"], automaticAttempts: 1,
      failureReason: null, prompts: [{ id: "prompt-1", authorUserId: "user-1", authorName: "Ada", text: "Keep clients working" }], attempts: [],
      questions: [{ id: "q1", question: "Keep legacy fields?", answer: "Yes, deprecate first", answeredByUserId: "user-1", answeredByName: "Ada", requestedAt: 1, answeredAt: 2 }],
      createdAt: 1, updatedAt: 2, resolvedAt: null,
    };
    const prompt = renderConflictResolverPrompt({ conflict, sourceSummary: "Changed API", sourceConflictReason: "409 conflict", sessionBrief: "## Session objective\nShip safely" });
    expect(prompt).toContain("# Merge Resolver system run");
    expect(prompt).toContain("src/api.ts");
    expect(prompt).toContain("Keep legacy fields?\n  Answer: Yes, deprecate first (Ada)");
    expect(prompt).toContain("Changed API");
    expect(prompt).toContain("## Session objective\nShip safely");
    expect(prompt).toContain("openfloor_request_conflict_input");
    expect(prompt).toContain("## Original authored prompts\n\n- Ada: Keep clients working");
    expect(prompt).toContain("Mutually exclusive authored outcomes");
  });
});

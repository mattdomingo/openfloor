import { describe, expect, it } from "vitest";
import {
  normalizeAgentName,
  parseAgentInput,
  parseAssignmentInput,
  parseMessageInput,
  parseObjectiveInput,
  parseQueueMergeInput,
  parseQueueOrderInput,
  parseQueuePromptInput,
  parseSessionInput,
} from "@/lib/validation";

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

describe("floor input validation", () => {
  it("normalizes real agent metadata and case-insensitive names", () => {
    expect(parseAgentInput({ name: "  Lumen Agent ", role: " Researcher ", task: " Map APIs ", ownerUserId: " owner " })).toEqual({
      name: "Lumen Agent",
      nameKey: "lumen agent",
      role: "Researcher",
      task: "Map APIs",
      ownerUserId: "owner",
    });
    expect(normalizeAgentName("  LUMEN   Agent ")).toBe("lumen agent");
  });

  it("validates assignments, messages, prompts, ordering, and merge lists", () => {
    expect(parseAssignmentInput({ task: "  " })).toEqual({ task: null });
    expect(parseMessageInput({ text: " Hello ", recipientUserId: "member" })).toEqual({ text: "Hello", recipientUserId: "member" });
    expect(parseQueuePromptInput({ prompt: " Do work " })).toEqual({ prompt: "Do work", agentId: null });
    expect(parseQueueOrderInput({ itemIds: [] })).toEqual({ itemIds: [] });
    expect(parseQueueMergeInput({ itemIds: ["one", "two"] })).toEqual({ itemIds: ["one", "two"] });
    expect(parseQueueMergeInput({ itemIds: ["one", "one"] })).toBeNull();
  });

  it("rejects empty and oversized floor values", () => {
    expect(parseAgentInput({ name: "", role: "Role", task: "Task", ownerUserId: "owner" })).toBeNull();
    expect(parseMessageInput({ text: "" })).toBeNull();
    expect(parseQueuePromptInput({ prompt: "x".repeat(4001) })).toBeNull();
  });
});

describe("objective input validation", () => {
  it("normalizes text and empty values", () => {
    expect(parseObjectiveInput({ objective: "  Shared objective  " })).toEqual({ objective: "Shared objective" });
    expect(parseObjectiveInput({ objective: "  " })).toEqual({ objective: null });
    expect(parseObjectiveInput({ objective: null })).toEqual({ objective: null });
  });

  it("rejects missing, non-string, and oversized values", () => {
    expect(parseObjectiveInput({})).toBeNull();
    expect(parseObjectiveInput({ objective: 42 })).toBeNull();
    expect(parseObjectiveInput({ objective: "x".repeat(2001) })).toBeNull();
  });
});

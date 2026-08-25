import { describe, expect, it } from "vitest";
import {
  normalizeAgentName,
  parseAgentInput,
  parseAssignmentInput,
  parseCredentialConnectInput,
  parseMessageInput,
  parseObjectiveInput,
  parseProfileInput,
  parseQueueOrderInput,
  parseQueuePromptInput,
  parseRepositoryCandidateInput,
  parseRepositoryConnectionInput,
  parseRoutingSettingsInput,
  parseConflictInputRequest,
  parseConflictAnswersInput,
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

describe("profile input validation", () => {
  it("trims and normalizes valid input", () => {
    expect(parseProfileInput({ firstName: "  Matt ", lastName: " Domingo ", githubHandle: " octocat " })).toEqual({
      firstName: "Matt",
      lastName: "Domingo",
      githubHandle: "octocat",
    });
  });

  it("collapses internal whitespace via NFKC normalization, like agent names", () => {
    expect(parseProfileInput({ firstName: "Matt   G", lastName: "Domingo", githubHandle: null })).toEqual({
      firstName: "Matt G",
      lastName: "Domingo",
      githubHandle: null,
    });
  });

  it("maps an absent or empty GitHub handle to null", () => {
    expect(parseProfileInput({ firstName: "Matt", lastName: "Domingo" })).toEqual({
      firstName: "Matt",
      lastName: "Domingo",
      githubHandle: null,
    });
    expect(parseProfileInput({ firstName: "Matt", lastName: "Domingo", githubHandle: "   " })).toEqual({
      firstName: "Matt",
      lastName: "Domingo",
      githubHandle: null,
    });
  });

  it("rejects blank or missing names", () => {
    expect(parseProfileInput(null)).toBeNull();
    expect(parseProfileInput({ firstName: "  ", lastName: "Domingo" })).toBeNull();
    expect(parseProfileInput({ firstName: "Matt", lastName: "  " })).toBeNull();
    expect(parseProfileInput({ firstName: "Matt" })).toBeNull();
  });

  it("enforces the 50/50/39 length caps", () => {
    expect(parseProfileInput({ firstName: "x".repeat(51), lastName: "Domingo" })).toBeNull();
    expect(parseProfileInput({ firstName: "Matt", lastName: "x".repeat(51) })).toBeNull();
    expect(parseProfileInput({ firstName: "Matt", lastName: "Domingo", githubHandle: "x".repeat(40) })).toBeNull();
    expect(parseProfileInput({ firstName: "x".repeat(50), lastName: "Domingo" })).not.toBeNull();
    expect(parseProfileInput({ firstName: "Matt", lastName: "Domingo", githubHandle: "x".repeat(39) })).not.toBeNull();
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
      provider: "openai",
    });
    expect(normalizeAgentName("  LUMEN   Agent ")).toBe("lumen agent");
  });

  it("accepts a known provider and rejects unknown ones", () => {
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "anthropic" })?.provider).toBe("anthropic");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "openai" })?.provider).toBe("openai");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "kimi" })?.provider).toBe("kimi");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "gemini" })?.provider).toBe("gemini");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "mistral" })).toBeNull();
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: 7 })).toBeNull();
  });

  it("validates assignments, messages, prompts, and ordering", () => {
    expect(parseAssignmentInput({ task: "  " })).toEqual({ task: null });
    expect(parseMessageInput({ text: " Hello ", recipientUserId: "member" })).toEqual({ text: "Hello", recipientUserId: "member" });
    expect(parseQueuePromptInput({ prompt: " Do work " })).toEqual({ prompt: "Do work", agentId: null });
    expect(parseQueueOrderInput({ itemIds: [] })).toEqual({ itemIds: [] });
  });

  it("rejects empty and oversized floor values", () => {
    expect(parseAgentInput({ name: "", role: "Role", task: "Task", ownerUserId: "owner" })).toBeNull();
    expect(parseMessageInput({ text: "" })).toBeNull();
    expect(parseQueuePromptInput({ prompt: "x".repeat(4001) })).toBeNull();
  });

  it("normalizes repository selection and ordered check commands", () => {
    expect(parseRepositoryConnectionInput({
      repositoryId: " 123 ",
      baseBranch: " main ",
      checkCommands: [" npm test ", " npm run build "],
    })).toEqual({ repositoryId: "123", baseBranch: "main", checkCommands: ["npm test", "npm run build"] });
    expect(parseRepositoryConnectionInput({ repositoryId: "123", baseBranch: "main", checkCommands: [] })).toEqual({
      repositoryId: "123", baseBranch: "main", checkCommands: [],
    });
    expect(parseRepositoryConnectionInput({ repositoryId: "123", baseBranch: "main" })).toEqual({
      repositoryId: "123", baseBranch: "main", checkCommands: [],
    });
    expect(parseRepositoryConnectionInput({ repositoryId: "123", baseBranch: "main", checkCommands: ["x".repeat(501)] })).toBeNull();
  });

  it("normalizes and bounds candidate metadata", () => {
    expect(parseRepositoryCandidateInput({ name: "  Release   coordination  ", description: "  Ship the session objective.  " }))
      .toEqual({ name: "Release coordination", description: "Ship the session objective." });
    expect(parseRepositoryCandidateInput({ name: "", description: "" })).toBeNull();
    expect(parseRepositoryCandidateInput({ name: "x".repeat(101), description: "" })).toBeNull();
    expect(parseRepositoryCandidateInput({ name: "Candidate", description: "x".repeat(2001) })).toBeNull();
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

describe("credential connect input validation", () => {
  it("trims and accepts a single opaque token", () => {
    expect(parseCredentialConnectInput({ apiKey: "  sk-ant-api03-abcd  " })).toEqual({ apiKey: "sk-ant-api03-abcd" });
  });

  it("rejects missing, empty, oversized, and multi-token values", () => {
    expect(parseCredentialConnectInput(null)).toBeNull();
    expect(parseCredentialConnectInput({})).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: 42 })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: "   " })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: `sk-${"x".repeat(512)}` })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: "sk-abc def" })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: "sk-abc\ndef" })).toBeNull();
  });
});

describe("merge conflict input validation", () => {
  it("preserves omitted routing settings and requires at least one setting", () => {
    expect(parseRoutingSettingsInput({ autoResolveConflicts: false })).toEqual({ autoResolveConflicts: false });
    expect(parseRoutingSettingsInput({ autoDispatch: true, autoResolveConflicts: false })).toEqual({ autoDispatch: true, autoResolveConflicts: false });
    expect(parseRoutingSettingsInput({ autoProvisionAgents: false, autoAgentProvider: "gemini" })).toEqual({ autoProvisionAgents: false, autoAgentProvider: "gemini" });
    expect(parseRoutingSettingsInput({ autoAgentProvider: null })).toEqual({ autoAgentProvider: null });
    expect(parseRoutingSettingsInput({})).toBeNull();
    expect(parseRoutingSettingsInput({ autoResolveConflicts: "yes" })).toBeNull();
    expect(parseRoutingSettingsInput({ autoProvisionAgents: "true" })).toBeNull();
    expect(parseRoutingSettingsInput({ autoAgentProvider: "unknown" })).toBeNull();
  });

  it("bounds resolver questions and exact member answers", () => {
    expect(parseConflictInputRequest({ explanation: " Need a product choice ", questions: [" Keep old API? "] }))
      .toEqual({ explanation: "Need a product choice", questions: ["Keep old API?"] });
    expect(parseConflictInputRequest({ explanation: "x", questions: [] })).toBeNull();
    expect(parseConflictInputRequest({ explanation: "x", questions: ["a", "b", "c", "d"] })).toBeNull();
    expect(parseConflictAnswersInput({ answers: [{ questionId: "q1", answer: " Keep compatibility " }] }))
      .toEqual({ answers: [{ questionId: "q1", answer: "Keep compatibility" }] });
    expect(parseConflictAnswersInput({ answers: [{ questionId: "q1", answer: "a" }, { questionId: "q1", answer: "b" }] })).toBeNull();
  });
});

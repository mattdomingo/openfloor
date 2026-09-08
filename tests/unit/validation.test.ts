import { describe, expect, it } from "vitest";
import {
  normalizeAgentName,
  parseAgentInput,
  parseAgentSettingsInput,
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
  parseMergeLockInput,
  parseConflictInputRequest,
  parseConflictAnswersInput,
  parseEarlyAccessWaitlistInput,
  parseSessionCreateInput,
  parseSessionInput,
} from "@/lib/validation";

describe("early-access waitlist validation", () => {
  it("normalizes names and email addresses", () => {
    expect(parseEarlyAccessWaitlistInput({ name: "  Ada   Lovelace ", email: " ADA@Example.COM " })).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
  });

  it("rejects malformed and oversized fields", () => {
    expect(parseEarlyAccessWaitlistInput(null)).toBeNull();
    expect(parseEarlyAccessWaitlistInput({ name: "", email: "person@example.com" })).toBeNull();
    expect(parseEarlyAccessWaitlistInput({ name: "A", email: "not-an-email" })).toBeNull();
    expect(parseEarlyAccessWaitlistInput({ name: "x".repeat(101), email: "person@example.com" })).toBeNull();
  });
});

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

describe("session create input validation", () => {
  const base = { title: "Launch room", objective: null, accountInstallationId: "install-1", repositoryId: "repo-1" };

  it("normalizes a supplied candidate name", () => {
    expect(parseSessionCreateInput({ ...base, candidateName: "  Checkout   revamp  " })).toEqual({
      title: "Launch room",
      objective: null,
      accountInstallationId: "install-1",
      repositoryId: "repo-1",
      candidateName: "Checkout revamp",
    });
  });

  it("defaults candidateName to null when absent, empty, or whitespace-only", () => {
    expect(parseSessionCreateInput(base)?.candidateName).toBeNull();
    expect(parseSessionCreateInput({ ...base, candidateName: "" })?.candidateName).toBeNull();
    expect(parseSessionCreateInput({ ...base, candidateName: "   " })?.candidateName).toBeNull();
  });

  it("rejects a candidate name over 100 characters or the wrong type", () => {
    expect(parseSessionCreateInput({ ...base, candidateName: "x".repeat(101) })).toBeNull();
    expect(parseSessionCreateInput({ ...base, candidateName: 42 })).toBeNull();
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
      credentialKind: null,
      model: null,
    });
    expect(normalizeAgentName("  LUMEN   Agent ")).toBe("lumen agent");
  });

  it("accepts a known provider and rejects unknown ones", () => {
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "anthropic" })?.provider).toBe("anthropic");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "openai" })?.provider).toBe("openai");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "kimi" })?.provider).toBe("kimi");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "gemini" })?.provider).toBe("gemini");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "glm" })?.provider).toBe("glm");
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: "mistral" })).toBeNull();
    expect(parseAgentInput({ name: "A", role: "R", task: "T", ownerUserId: "o", provider: 7 })).toBeNull();
  });

  it("accepts a credential kind only among the provider's supported kinds", () => {
    const base = { name: "A", role: "R", task: "T", ownerUserId: "o" };
    expect(parseAgentInput({ ...base, provider: "anthropic", credentialKind: "oauth" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "openai", credentialKind: "api_key" })?.credentialKind).toBe("api_key");
    // openai's oauth kind went live when Spike D passed (2026-08-26).
    expect(parseAgentInput({ ...base, provider: "openai", credentialKind: "oauth" })).toBeNull();
    // Omitted and explicit null both mean "the owner's default".
    expect(parseAgentInput({ ...base, provider: "anthropic" })?.credentialKind).toBeNull();
    expect(parseAgentInput({ ...base, provider: "anthropic", credentialKind: null })?.credentialKind).toBeNull();
    // A Kimi Code plan key is a real kimi kind (2026-08-26 decision-log entry).
    expect(parseAgentInput({ ...base, provider: "kimi", credentialKind: "oauth" })).toBeNull();
    // A kind the provider does not support, and garbage, are 400s.
    expect(parseAgentInput({ ...base, provider: "gemini", credentialKind: "oauth" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "glm", credentialKind: "oauth" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "anthropic", credentialKind: "subscription" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "anthropic", credentialKind: 7 })).toBeNull();
  });

  it("accepts a model only from the provider's closed allowlist", () => {
    const base = { name: "A", role: "R", task: "T", ownerUserId: "o" };
    expect(parseAgentInput({ ...base, provider: "anthropic", model: "claude-sonnet-5" })?.model).toBe("claude-sonnet-5");
    // The right id under the wrong provider is a 400, never a vendor 404 mid-run.
    expect(parseAgentInput({ ...base, provider: "kimi", model: "claude-opus-5" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "anthropic", model: "claude-opus-5-20260101" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "anthropic", model: 7 })).toBeNull();
    // Omitted and explicit null both mean "the provider's default".
    expect(parseAgentInput({ ...base })?.model).toBeNull();
    expect(parseAgentInput({ ...base, model: null })?.model).toBeNull();
  });

  it("parses partial agent-settings patches, keeping absent distinct from explicit null", () => {
    // A task-only body is the old parseAgentTaskInput contract, unchanged.
    expect(parseAgentSettingsInput({ task: " Refine the API " })).toEqual({ task: "Refine the API" });
    expect(parseAgentSettingsInput({ task: "" })).toBeNull();
    expect(parseAgentSettingsInput({ task: "x".repeat(1001) })).toBeNull();
    // Explicit null means "reset to the default" and must survive parsing as
    // a PRESENT key — otherwise Billing could never return to Owner's default.
    const kindReset = parseAgentSettingsInput({ credentialKind: null });
    expect(kindReset).toEqual({ credentialKind: null });
    expect(kindReset && "credentialKind" in kindReset).toBe(true);
    const kindOmitted = parseAgentSettingsInput({ model: "claude-sonnet-5" });
    expect(kindOmitted && "credentialKind" in kindOmitted).toBe(false);
    expect(parseAgentSettingsInput({ model: null })).toEqual({ model: null });
    expect(parseAgentSettingsInput({ credentialKind: "oauth", model: null, task: "T" })).toBeNull();
    // An empty patch and garbage values are 400s.
    expect(parseAgentSettingsInput({})).toBeNull();
    expect(parseAgentSettingsInput({ credentialKind: "subscription" })).toBeNull();
    expect(parseAgentSettingsInput({ model: 7 })).toBeNull();
    expect(parseAgentSettingsInput(null)).toBeNull();
  });

  it("validates assignments, messages, prompts, and ordering", () => {
    expect(parseAssignmentInput({ task: "  " })).toEqual({ task: null });
    expect(parseMessageInput({ text: " Hello ", recipientUserId: "member" })).toEqual({ text: "Hello", recipientUserId: "member", attachmentIds: [] });
    expect(parseMessageInput({ text: "Hello", recipientUserId: null, attachmentIds: ["file-1"] })).toEqual({ text: "Hello", recipientUserId: null, attachmentIds: ["file-1"] });
    // Attachments are team-chat only — a DM attachment would leak into the
    // session-wide artifacts area.
    expect(parseMessageInput({ text: "Hello", recipientUserId: "member", attachmentIds: ["file-1"] })).toBeNull();
    expect(parseMessageInput({ text: "Hello", attachmentIds: Array.from({ length: 9 }, (_, i) => `f${i}`) })).toBeNull();
    expect(parseMessageInput({ text: "Hello", attachmentIds: [""] })).toBeNull();
    expect(parseQueuePromptInput({ prompt: " Do work " })).toEqual({ prompt: "Do work", agentId: null });
    expect(parseQueueOrderInput({ itemIds: [] })).toEqual({ itemIds: [] });
  });

  it("rejects empty and oversized floor values", () => {
    expect(parseAgentInput({ name: "", role: "Role", task: "Task", ownerUserId: "owner" })).toBeNull();
    expect(parseMessageInput({ text: "" })).toBeNull();
    expect(parseQueuePromptInput({ prompt: "x".repeat(4001) })).toBeNull();
  });

  it("normalizes repository selection", () => {
    expect(parseRepositoryConnectionInput({
      repositoryId: " 123 ",
      baseBranch: " main ",
    })).toEqual({ repositoryId: "123", accountInstallationId: null, baseBranch: "main" });
    expect(parseRepositoryConnectionInput({ repositoryId: "123", baseBranch: "main", accountInstallationId: " install-1 " })).toEqual({
      repositoryId: "123", accountInstallationId: "install-1", baseBranch: "main",
    });
    expect(parseRepositoryConnectionInput({ repositoryId: "", baseBranch: "main" })).toBeNull();
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
  it("trims and accepts a single opaque token as an api_key", () => {
    expect(parseCredentialConnectInput({ apiKey: "  sk-ant-api03-abcd  " })).toEqual({
      kind: "api_key",
      secret: "sk-ant-api03-abcd",
      fingerprintValue: "sk-ant-api03-abcd",
    });
  });

  it("accepts a setup token as an oauth credential under the same token rules", () => {
    expect(parseCredentialConnectInput({ setupToken: "  sk-ant-oat01-token  " })).toEqual({
      kind: "oauth",
      secret: "sk-ant-oat01-token",
      fingerprintValue: "sk-ant-oat01-token",
    });
    expect(parseCredentialConnectInput({ setupToken: "two tokens" })).toBeNull();
    expect(parseCredentialConnectInput({ setupToken: `sk-${"x".repeat(512)}` })).toBeNull();
  });

  it("accepts an auth bundle as oauth, shape-checked and fingerprinted by account id", () => {
    const bundle = JSON.stringify({ tokens: { account_id: "acct-1234", access_token: "at", refresh_token: "rt" }, last_refresh: "now" });
    expect(parseCredentialConnectInput({ authJson: bundle })).toEqual({
      kind: "oauth",
      secret: bundle,
      fingerprintValue: "acct-1234",
    });
    expect(parseCredentialConnectInput({ authJson: "not json" })).toBeNull();
    expect(parseCredentialConnectInput({ authJson: "[1,2]" })).toBeNull();
    expect(parseCredentialConnectInput({ authJson: JSON.stringify({ tokens: {} }) })).toBeNull();
    expect(parseCredentialConnectInput({ authJson: JSON.stringify({ tokens: { account_id: "a" } }) })).toBeNull();
    expect(parseCredentialConnectInput({ authJson: `{"tokens":{"account_id":"a","access_token":"${"x".repeat(8192)}"}}` })).toBeNull();
  });

  it("rejects missing, empty, oversized, multi-token, and ambiguous values", () => {
    expect(parseCredentialConnectInput(null)).toBeNull();
    expect(parseCredentialConnectInput({})).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: 42 })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: "   " })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: `sk-${"x".repeat(512)}` })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: "sk-abc def" })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: "sk-abc\ndef" })).toBeNull();
    // Exactly one field: two shapes at once is a caller bug, not a choice.
    expect(parseCredentialConnectInput({ apiKey: "sk-a", setupToken: "sk-b" })).toBeNull();
    expect(parseCredentialConnectInput({ apiKey: "sk-a", authJson: "{}" })).toBeNull();
  });
});

describe("merge conflict input validation", () => {
  it("requires an explicit boolean merge lock state", () => {
    expect(parseMergeLockInput({ locked: true })).toEqual({ locked: true });
    expect(parseMergeLockInput({ locked: false })).toEqual({ locked: false });
    expect(parseMergeLockInput({})).toBeNull();
    expect(parseMergeLockInput({ locked: "true" })).toBeNull();
  });

  it("preserves omitted routing settings and requires at least one setting", () => {
    expect(parseRoutingSettingsInput({ autoResolveConflicts: false })).toEqual({ autoResolveConflicts: false });
    expect(parseRoutingSettingsInput({ autoDispatch: true, autoResolveConflicts: false })).toEqual({ autoDispatch: true, autoResolveConflicts: false });
    expect(parseRoutingSettingsInput({ autoProvisionAgents: false, autoAgentProvider: "gemini" })).toEqual({ autoProvisionAgents: false, autoAgentProvider: "gemini" });
    expect(parseRoutingSettingsInput({ autoAgentProvider: null })).toEqual({ autoAgentProvider: null });
    expect(parseRoutingSettingsInput({})).toBeNull();
    expect(parseRoutingSettingsInput({ autoInjectFeedback: false })).toEqual({ autoInjectFeedback: false });
    expect(parseRoutingSettingsInput({ autoResolveConflicts: "yes" })).toBeNull();
    expect(parseRoutingSettingsInput({ autoInjectFeedback: "off" })).toBeNull();
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

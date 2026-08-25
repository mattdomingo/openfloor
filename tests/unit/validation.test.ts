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
      credentialKind: null,
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

  it("accepts a credential kind only among the provider's supported kinds", () => {
    const base = { name: "A", role: "R", task: "T", ownerUserId: "o" };
    expect(parseAgentInput({ ...base, provider: "anthropic", credentialKind: "oauth" })?.credentialKind).toBe("oauth");
    expect(parseAgentInput({ ...base, provider: "openai", credentialKind: "api_key" })?.credentialKind).toBe("api_key");
    // Omitted and explicit null both mean "the owner's default".
    expect(parseAgentInput({ ...base, provider: "anthropic" })?.credentialKind).toBeNull();
    expect(parseAgentInput({ ...base, provider: "anthropic", credentialKind: null })?.credentialKind).toBeNull();
    // A kind the provider does not support, and garbage, are 400s.
    expect(parseAgentInput({ ...base, provider: "kimi", credentialKind: "oauth" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "gemini", credentialKind: "oauth" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "anthropic", credentialKind: "subscription" })).toBeNull();
    expect(parseAgentInput({ ...base, provider: "anthropic", credentialKind: 7 })).toBeNull();
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

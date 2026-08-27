import {
  credentialKindsForProvider,
  parseCredentialKind,
  parseCredentialProvider,
  PROVIDER_MODELS,
  type CredentialKind,
  type CredentialProvider,
} from "./provider-credentials";

export type SessionInput = { title: string; objective: string | null };
export type SessionCreateInput = SessionInput & { accountInstallationId: string; repositoryId: string; candidateName: string | null };
export type ObjectiveInput = { objective: string | null };
export type AgentInput = {
  name: string;
  nameKey: string;
  role: string;
  task: string;
  ownerUserId: string;
  provider: CredentialProvider;
  credentialKind: CredentialKind | null;
  model: string | null;
};
// Partial settings patch for an existing persistent agent. `model` and
// `credentialKind` distinguish ABSENT (leave the field alone) from explicit
// null (reset to the default) — collapsing the two would make the Billing
// control unable to return to "Owner's default".
export type AgentSettingsInput = { task?: string; model?: string | null; credentialKind?: CredentialKind | null };
export type AgentPauseInput = { paused: boolean };
export type AssignmentInput = { task: string | null };
export type MessageInput = { text: string; recipientUserId: string | null; attachmentIds?: string[] };
export type QueuePromptInput = { prompt: string; agentId: string | null };
export type RoutingSettingsInput = { autoDispatch?: boolean; autoProvisionAgents?: boolean; autoAgentProvider?: CredentialProvider | null; autoResolveConflicts?: boolean };
export type ConflictInputRequest = { explanation: string; questions: string[] };
export type ConflictAnswersInput = { answers: Array<{ questionId: string; answer: string }> };
export type QueueOrderInput = { itemIds: string[] };
export type QueuePromptTextInput = { text: string };
export type QueueItemPauseInput = { paused: boolean };
export type QueueItemTargetInput = { agentId: string };
export type RepositoryConnectionInput = { repositoryId: string; accountInstallationId: string | null; baseBranch: string };
export type RepositoryCandidateInput = { name: string; description: string };
export type ProfileInput = { firstName: string; lastName: string; githubHandle: string | null };
// Discriminated by kind: `secret` is what gets encrypted at rest, and
// `fingerprintValue` is what the last-four fingerprint is taken from — the
// token itself for an API key or Claude setup token, the ChatGPT account id
// for an auth bundle (never the refresh token).
export type CredentialConnectInput = { kind: CredentialKind; secret: string; fingerprintValue: string };

// null clears the limit (no cap). Whole-dollar granularity from the
// Settings input; the route converts to micro-USD for storage.
export type CredentialLimitInput = { kind: CredentialKind; monthlyLimitUsd: number | null };

const MAX_PROFILE_NAME_LENGTH = 50;
const MAX_GITHUB_HANDLE_LENGTH = 39;
const MAX_API_KEY_LENGTH = 512;
const MAX_AUTH_JSON_LENGTH = 8192;

export function parseSessionInput(value: unknown): SessionInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { title?: unknown; objective?: unknown };
  if (typeof input.title !== "string") return null;
  const title = input.title.trim();
  if (!title || title.length > 100) return null;
  if (input.objective != null && typeof input.objective !== "string") return null;
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  if (objective.length > 2000) return null;
  return { title, objective: objective || null };
}

export function parseSessionCreateInput(value: unknown): SessionCreateInput | null {
  const session = parseSessionInput(value);
  if (!session || !value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.accountInstallationId !== "string" || typeof input.repositoryId !== "string") return null;
  const accountInstallationId = input.accountInstallationId.trim();
  const repositoryId = input.repositoryId.trim();
  if (!accountInstallationId || accountInstallationId.length > 100 || !repositoryId || repositoryId.length > 100) return null;
  if (input.candidateName != null && typeof input.candidateName !== "string") return null;
  // Same normalization as parseRepositoryCandidateInput's `name` — the two
  // paths write the same repository_candidates.name column. Empty/absent
  // falls back to the session title, so existing callers are unaffected.
  const candidateNameRaw = typeof input.candidateName === "string"
    ? input.candidateName.normalize("NFKC").trim().replace(/\s+/g, " ")
    : "";
  if (candidateNameRaw.length > 100) return null;
  return { ...session, accountInstallationId, repositoryId, candidateName: candidateNameRaw || null };
}

export function parseObjectiveInput(value: unknown): ObjectiveInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { objective?: unknown };
  if (input.objective !== null && typeof input.objective !== "string") return null;
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  if (objective.length > 2000) return null;
  return { objective: objective || null };
}

export function normalizeAgentName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function parseAgentInput(value: unknown): AgentInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || typeof input.role !== "string" || typeof input.task !== "string" || typeof input.ownerUserId !== "string") return null;
  const name = input.name.normalize("NFKC").trim().replace(/\s+/g, " ");
  const role = input.role.trim();
  const task = input.task.trim();
  const ownerUserId = input.ownerUserId.trim();
  if (!name || name.length > 24 || !role || role.length > 80 || !task || task.length > 1000 || !ownerUserId || ownerUserId.length > 100) return null;
  if (input.provider !== undefined && parseCredentialProvider(input.provider) === null) return null;
  const provider = parseCredentialProvider(input.provider) ?? "openai";
  // Optional billing choice, valid only among the provider's supported kinds;
  // null/omitted means "the owner's default" (api_key when present).
  let credentialKind: CredentialKind | null = null;
  if (input.credentialKind !== undefined && input.credentialKind !== null) {
    const kind = parseCredentialKind(input.credentialKind);
    if (!kind || !credentialKindsForProvider(provider).includes(kind)) return null;
    credentialKind = kind;
  }
  // Optional model, valid only among the provider's closed allowlist so an
  // unknown id 400s here instead of 404ing at the vendor mid-run;
  // omitted/null means "the provider's default".
  let model: string | null = null;
  if (input.model !== undefined && input.model !== null) {
    if (typeof input.model !== "string" || !PROVIDER_MODELS[provider].includes(input.model)) return null;
    model = input.model;
  }
  return { name, nameKey: normalizeAgentName(name), role, task, ownerUserId, provider, credentialKind, model };
}

// Generalizes the old parseAgentTaskInput: at least one key must be present,
// and the task rules are unchanged (trimmed, non-empty, ≤1000 — a
// generalization, not a relaxation). `model` and `credentialKind` are only
// shape-checked here; both are validated against the agent's STORED provider
// in db/floor.ts — the body carries no provider, and trusting a
// client-supplied one would let a caller set claude-opus-5 on a Kimi agent.
export function parseAgentSettingsInput(value: unknown): AgentSettingsInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const patch: AgentSettingsInput = {};
  if (input.task !== undefined) {
    if (typeof input.task !== "string") return null;
    const task = input.task.trim();
    if (!task || task.length > 1000) return null;
    patch.task = task;
  }
  if (input.model !== undefined) {
    if (input.model !== null && typeof input.model !== "string") return null;
    patch.model = input.model;
  }
  if (input.credentialKind !== undefined) {
    if (input.credentialKind !== null && parseCredentialKind(input.credentialKind) === null) return null;
    patch.credentialKind = input.credentialKind === null ? null : parseCredentialKind(input.credentialKind);
  }
  if (patch.task === undefined && patch.model === undefined && patch.credentialKind === undefined) return null;
  return patch;
}

export function parseAssignmentInput(value: unknown): AssignmentInput | null {
  if (!value || typeof value !== "object") return null;
  const taskValue = (value as Record<string, unknown>).task;
  if (taskValue !== null && typeof taskValue !== "string") return null;
  const task = typeof taskValue === "string" ? taskValue.trim() : "";
  if (task.length > 2000) return null;
  return { task: task || null };
}

export function parseMessageInput(value: unknown): MessageInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.text !== "string") return null;
  if (input.recipientUserId !== undefined && input.recipientUserId !== null && typeof input.recipientUserId !== "string") return null;
  if (input.attachmentIds !== undefined && !Array.isArray(input.attachmentIds)) return null;
  const attachmentIds = (input.attachmentIds ?? []) as unknown[];
  if (attachmentIds.length > 8 || attachmentIds.some((id) => typeof id !== "string" || !id || id.length > 100)) return null;
  const text = input.text.trim();
  const recipientUserId = typeof input.recipientUserId === "string" ? input.recipientUserId.trim() : null;
  if (!text || text.length > 4000 || (recipientUserId !== null && (!recipientUserId || recipientUserId.length > 100))) return null;
  // Attachments are team-chat only: a DM attachment would surface in the
  // session-wide artifacts area and leak the private exchange.
  if (recipientUserId !== null && attachmentIds.length > 0) return null;
  return { text, recipientUserId, attachmentIds: attachmentIds as string[] };
}

export function parseQueuePromptInput(value: unknown): QueuePromptInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.prompt !== "string") return null;
  if (input.agentId !== undefined && input.agentId !== null && typeof input.agentId !== "string") return null;
  const prompt = input.prompt.trim();
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : null;
  if (!prompt || prompt.length > 4000 || (agentId !== null && (!agentId || agentId.length > 100))) return null;
  return { prompt, agentId };
}

export function parseRoutingSettingsInput(value: unknown): RoutingSettingsInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.autoDispatch === undefined && input.autoProvisionAgents === undefined && input.autoAgentProvider === undefined && input.autoResolveConflicts === undefined) return null;
  if (input.autoDispatch !== undefined && typeof input.autoDispatch !== "boolean") return null;
  if (input.autoProvisionAgents !== undefined && typeof input.autoProvisionAgents !== "boolean") return null;
  if (input.autoAgentProvider !== undefined && input.autoAgentProvider !== null && parseCredentialProvider(input.autoAgentProvider) === null) return null;
  if (input.autoResolveConflicts !== undefined && typeof input.autoResolveConflicts !== "boolean") return null;
  return {
    ...(typeof input.autoDispatch === "boolean" ? { autoDispatch: input.autoDispatch } : {}),
    ...(typeof input.autoProvisionAgents === "boolean" ? { autoProvisionAgents: input.autoProvisionAgents } : {}),
    ...(input.autoAgentProvider === null ? { autoAgentProvider: null } : parseCredentialProvider(input.autoAgentProvider) ? { autoAgentProvider: parseCredentialProvider(input.autoAgentProvider)! } : {}),
    ...(typeof input.autoResolveConflicts === "boolean" ? { autoResolveConflicts: input.autoResolveConflicts } : {}),
  };
}

export function parseConflictInputRequest(value: unknown): ConflictInputRequest | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.explanation !== "string" || !Array.isArray(input.questions)) return null;
  const explanation = input.explanation.trim();
  if (!explanation || explanation.length > 4_000 || input.questions.length < 1 || input.questions.length > 3) return null;
  if (input.questions.some((question) => typeof question !== "string")) return null;
  const questions = input.questions.map((question) => (question as string).trim());
  if (questions.some((question) => !question || question.length > 500)) return null;
  return { explanation, questions };
}

export function parseConflictAnswersInput(value: unknown): ConflictAnswersInput | null {
  if (!value || typeof value !== "object") return null;
  const answers = (value as Record<string, unknown>).answers;
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 3) return null;
  const parsed: ConflictAnswersInput["answers"] = [];
  for (const item of answers) {
    if (!item || typeof item !== "object") return null;
    const answer = item as Record<string, unknown>;
    if (typeof answer.questionId !== "string" || typeof answer.answer !== "string") return null;
    const questionId = answer.questionId.trim();
    const text = answer.answer.trim();
    if (!questionId || questionId.length > 100 || !text || text.length > 2_000) return null;
    parsed.push({ questionId, answer: text });
  }
  if (new Set(parsed.map((answer) => answer.questionId)).size !== parsed.length) return null;
  return { answers: parsed };
}

export function parseQueueOrderInput(value: unknown): QueueOrderInput | null {
  return parseIdList(value, "itemIds", 0);
}

export function parseQueuePromptTextInput(value: unknown): QueuePromptTextInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.text !== "string") return null;
  const text = input.text.trim();
  if (!text || text.length > 4000) return null;
  return { text };
}

export function parseQueueItemPauseInput(value: unknown): QueueItemPauseInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.paused !== "boolean") return null;
  return { paused: input.paused };
}

export function parseAgentPauseInput(value: unknown): AgentPauseInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.paused !== "boolean") return null;
  return { paused: input.paused };
}

export function parseQueueItemTargetInput(value: unknown): QueueItemTargetInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.agentId !== "string") return null;
  const agentId = input.agentId.trim();
  if (!agentId || agentId.length > 100) return null;
  return { agentId };
}

export function parseRepositoryConnectionInput(value: unknown): RepositoryConnectionInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.repositoryId !== "string" || typeof input.baseBranch !== "string") return null;
  const repositoryId = input.repositoryId.trim();
  if (input.accountInstallationId !== undefined && input.accountInstallationId !== null && typeof input.accountInstallationId !== "string") return null;
  const accountInstallationId = typeof input.accountInstallationId === "string" ? input.accountInstallationId.trim() : null;
  const baseBranch = input.baseBranch.trim();
  if (!repositoryId || repositoryId.length > 100 || (accountInstallationId !== null && (!accountInstallationId || accountInstallationId.length > 100)) || !baseBranch || baseBranch.length > 255) return null;
  return { repositoryId, accountInstallationId, baseBranch };
}

export function parseRepositoryCandidateInput(value: unknown): RepositoryCandidateInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || typeof input.description !== "string") return null;
  const name = input.name.normalize("NFKC").trim().replace(/\s+/g, " ");
  const description = input.description.trim();
  if (!name || name.length > 100 || description.length > 2_000) return null;
  return { name, description };
}

// Shared by onboarding (POST /api/account/onboarding) and account settings
// (PATCH /api/account/profile) so the two endpoints can never drift on what
// counts as a valid name or GitHub handle.
export function parseProfileInput(value: unknown): ProfileInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.firstName !== "string" || typeof input.lastName !== "string") return null;
  if (input.githubHandle !== undefined && input.githubHandle !== null && typeof input.githubHandle !== "string") return null;
  const firstName = input.firstName.normalize("NFKC").trim().replace(/\s+/g, " ");
  const lastName = input.lastName.normalize("NFKC").trim().replace(/\s+/g, " ");
  const githubHandle = typeof input.githubHandle === "string" ? input.githubHandle.trim() : "";
  if (!firstName || firstName.length > MAX_PROFILE_NAME_LENGTH) return null;
  if (!lastName || lastName.length > MAX_PROFILE_NAME_LENGTH) return null;
  if (githubHandle.length > MAX_GITHUB_HANDLE_LENGTH) return null;
  return { firstName, lastName, githubHandle: githubHandle || null };
}

// Three accepted shapes, one per credential form: { apiKey } (kind api_key),
// { setupToken } (kind oauth — the single opaque token `claude setup-token`
// mints), and { authJson } (kind oauth — a pasted ChatGPT auth bundle, a JSON
// object, shape-checked rather than treated as a bare token). Exactly one
// field must be present.
export function parseCredentialConnectInput(value: unknown): CredentialConnectInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { apiKey?: unknown; setupToken?: unknown; authJson?: unknown };
  const present = [input.apiKey, input.setupToken, input.authJson].filter((field) => field !== undefined);
  if (present.length !== 1) return null;
  if (input.apiKey !== undefined) {
    const apiKey = parseOpaqueToken(input.apiKey);
    return apiKey ? { kind: "api_key", secret: apiKey, fingerprintValue: apiKey } : null;
  }
  if (input.setupToken !== undefined) {
    const setupToken = parseOpaqueToken(input.setupToken);
    return setupToken ? { kind: "oauth", secret: setupToken, fingerprintValue: setupToken } : null;
  }
  if (typeof input.authJson !== "string") return null;
  const authJson = input.authJson.trim();
  if (!authJson || authJson.length > MAX_AUTH_JSON_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const { account_id: accountId, access_token: accessToken } = tokens as { account_id?: unknown; access_token?: unknown };
  if (typeof accountId !== "string" || !accountId || typeof accessToken !== "string" || !accessToken) return null;
  // The bundle is stored verbatim (encrypted) so unknown fields round-trip;
  // the fingerprint comes from the account id, never any token in the bundle.
  return { kind: "oauth", secret: authJson, fingerprintValue: accountId };
}

const MAX_MONTHLY_LIMIT_USD = 1_000_000;

export function parseCredentialLimitInput(value: unknown): CredentialLimitInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { kind?: unknown; monthlyLimitUsd?: unknown };
  const kind = parseCredentialKind(input.kind);
  if (!kind) return null;
  if (input.monthlyLimitUsd === null) return { kind, monthlyLimitUsd: null };
  if (typeof input.monthlyLimitUsd !== "number" || !Number.isFinite(input.monthlyLimitUsd)) return null;
  if (input.monthlyLimitUsd < 0 || input.monthlyLimitUsd > MAX_MONTHLY_LIMIT_USD) return null;
  return { kind, monthlyLimitUsd: input.monthlyLimitUsd };
}

function parseOpaqueToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || token.length > MAX_API_KEY_LENGTH) return null;
  // Credentials of this shape are single opaque tokens; embedded whitespace
  // or control characters mean a paste error, not a longer key format.
  if (/[\s\p{Cc}]/u.test(token)) return null;
  return token;
}

function parseIdList(value: unknown, key: string, minimum: number): { itemIds: string[] } | null {
  if (!value || typeof value !== "object") return null;
  const ids = (value as Record<string, unknown>)[key];
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > 500) return null;
  if (ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 100)) return null;
  const itemIds = ids.map((id) => (id as string).trim());
  if (new Set(itemIds).size !== itemIds.length) return null;
  return { itemIds };
}

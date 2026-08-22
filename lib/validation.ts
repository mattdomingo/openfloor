export type SessionInput = { title: string; objective: string | null };
export type ObjectiveInput = { objective: string | null };
export type AgentInput = { name: string; nameKey: string; role: string; task: string; ownerUserId: string; provider: "anthropic" | "openai" };
export type AgentTaskInput = { task: string };
export type AssignmentInput = { task: string | null };
export type MessageInput = { text: string; recipientUserId: string | null };
export type QueuePromptInput = { prompt: string; agentId: string | null };
export type AutoDispatchInput = { autoDispatch: boolean };
export type QueueOrderInput = { itemIds: string[] };
export type QueueMergeInput = { itemIds: string[] };
export type QueuePromptTextInput = { text: string };
export type QueueItemPauseInput = { paused: boolean };
export type RepositoryConnectionInput = { repositoryId: string; baseBranch: string; checkCommands: string[] };
export type RepositoryCandidateInput = { name: string; description: string };
export type ProfileInput = { firstName: string; lastName: string; githubHandle: string | null };
export type CredentialConnectInput = { apiKey: string };

const MAX_PROFILE_NAME_LENGTH = 50;
const MAX_GITHUB_HANDLE_LENGTH = 39;
const MAX_API_KEY_LENGTH = 512;

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
  if (input.provider !== undefined && input.provider !== "anthropic" && input.provider !== "openai") return null;
  const provider = (input.provider as "anthropic" | "openai" | undefined) ?? "openai";
  return { name, nameKey: normalizeAgentName(name), role, task, ownerUserId, provider };
}

export function parseAgentTaskInput(value: unknown): AgentTaskInput | null {
  if (!value || typeof value !== "object") return null;
  const taskValue = (value as Record<string, unknown>).task;
  if (typeof taskValue !== "string") return null;
  const task = taskValue.trim();
  if (!task || task.length > 1000) return null;
  return { task };
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
  const text = input.text.trim();
  const recipientUserId = typeof input.recipientUserId === "string" ? input.recipientUserId.trim() : null;
  if (!text || text.length > 4000 || (recipientUserId !== null && (!recipientUserId || recipientUserId.length > 100))) return null;
  return { text, recipientUserId };
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

export function parseAutoDispatchInput(value: unknown): AutoDispatchInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.autoDispatch !== "boolean") return null;
  return { autoDispatch: input.autoDispatch };
}

export function parseQueueOrderInput(value: unknown): QueueOrderInput | null {
  return parseIdList(value, "itemIds", 0);
}

export function parseQueueMergeInput(value: unknown): QueueMergeInput | null {
  return parseIdList(value, "itemIds", 2);
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

export function parseRepositoryConnectionInput(value: unknown): RepositoryConnectionInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.repositoryId !== "string" || typeof input.baseBranch !== "string") return null;
  if (input.checkCommands !== undefined && !Array.isArray(input.checkCommands)) return null;
  const repositoryId = input.repositoryId.trim();
  const baseBranch = input.baseBranch.trim();
  if (!repositoryId || repositoryId.length > 100 || !baseBranch || baseBranch.length > 255) return null;
  const rawCommands = input.checkCommands ?? [];
  if (!Array.isArray(rawCommands) || rawCommands.length > 8) return null;
  if (rawCommands.some((command) => typeof command !== "string")) return null;
  const checkCommands = rawCommands.map((command) => (command as string).trim());
  if (checkCommands.some((command) => !command || command.length > 500)) return null;
  return { repositoryId, baseBranch, checkCommands };
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

export function parseCredentialConnectInput(value: unknown): CredentialConnectInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { apiKey?: unknown };
  if (typeof input.apiKey !== "string") return null;
  const apiKey = input.apiKey.trim();
  if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH) return null;
  // API keys are single opaque tokens; embedded whitespace or control
  // characters mean a paste error, not a longer key format.
  if (/[\s\p{Cc}]/u.test(apiKey)) return null;
  return { apiKey };
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

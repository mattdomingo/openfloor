export type SessionInput = { title: string; objective: string | null };
export type ObjectiveInput = { objective: string | null };
export type AgentInput = { name: string; nameKey: string; role: string; task: string; ownerUserId: string };
export type AssignmentInput = { task: string | null };
export type MessageInput = { text: string; recipientUserId: string | null };
export type QueuePromptInput = { prompt: string; agentId: string | null };
export type QueueOrderInput = { itemIds: string[] };
export type QueueMergeInput = { itemIds: string[] };
export type RepositoryConnectionInput = { repositoryId: string; baseBranch: string; checkCommands: string[] };

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
  return { name, nameKey: normalizeAgentName(name), role, task, ownerUserId };
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

export function parseQueueOrderInput(value: unknown): QueueOrderInput | null {
  return parseIdList(value, "itemIds", 0);
}

export function parseQueueMergeInput(value: unknown): QueueMergeInput | null {
  return parseIdList(value, "itemIds", 2);
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

function parseIdList(value: unknown, key: string, minimum: number): { itemIds: string[] } | null {
  if (!value || typeof value !== "object") return null;
  const ids = (value as Record<string, unknown>)[key];
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > 500) return null;
  if (ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 100)) return null;
  const itemIds = ids.map((id) => (id as string).trim());
  if (new Set(itemIds).size !== itemIds.length) return null;
  return { itemIds };
}

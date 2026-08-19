export type SessionInput = { title: string; objective: string | null };
export type ObjectiveInput = { objective: string | null };

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

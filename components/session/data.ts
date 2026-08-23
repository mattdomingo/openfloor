export type PanelId = "brief" | "floor" | "queue";
export type RailId = Exclude<PanelId, "floor">;
export type AgentLayout = "focus" | "all";
export type WorkspaceScreen = "workspace" | "review";
export type QueueScope = "mine" | "team";
export type QueueOrderMode = "auto" | "manual";
export type TeamPanelView = "goals" | "chat";
export type ChatThread = "team" | string;

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

export function agentTone(id: string, floorIndex?: number) {
  if (floorIndex !== undefined) return `agent-${floorIndex % 5}`;
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `agent-${hash % 5}`;
}

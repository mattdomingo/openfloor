import type { AgentRun, AgentRunStatus } from "@/lib/floor-types";

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

// Shared with AgentCard.tsx (there is only one "live" run definition).
export const ACTIVE_RUN_STATUSES = new Set<AgentRunStatus>([
  "provisioning", "running", "checking", "publishing", "integrating", "cancel_requested",
]);

export function isRunLive(run: Pick<AgentRun, "status"> | null | undefined): boolean {
  return Boolean(run && ACTIVE_RUN_STATUSES.has(run.status));
}

// Every finished run — reply or task — records finalResponse; this is the
// text shown as a bubble once there's no live activity ticker to show instead.
export function agentReplyText(run: Pick<AgentRun, "status" | "finalResponse"> | null | undefined): string | null {
  return !isRunLive(run) && run?.finalResponse ? run.finalResponse : null;
}

// A reply run only ever holds provisioning/running/ready/failed/cancelled
// (it never passes through the task pipeline's checking/publishing/etc., and
// never earns a real "integrated"). Once one reaches "ready" it has fully
// answered its prompt, so the UI reads that as "answered" rather than the
// raw status, which otherwise misleadingly reused task-pipeline vocabulary
// for a run that never ran checks or published anything.
export function runStatusToken(run: Pick<AgentRun, "status" | "kind"> | null | undefined): string {
  if (!run) return "idle";
  if (run.kind === "reply" && run.status === "ready") return "answered";
  return run.status;
}

import type { AgentRun, AgentRunStatus, FloorAgent } from "@/lib/floor-types";

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

export function isRunLive(run: (Pick<AgentRun, "status"> & Partial<Pick<AgentRun, "rollbackStatus">>) | null | undefined): boolean {
  return Boolean(run && (ACTIVE_RUN_STATUSES.has(run.status) || run.rollbackStatus === "requested" || run.rollbackStatus === "running"));
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
export function runStatusToken(run: (Pick<AgentRun, "status" | "kind"> & Partial<Pick<AgentRun, "rollbackStatus">>) | null | undefined): string {
  if (!run) return "idle";
  if (run.rollbackStatus === "requested" || run.rollbackStatus === "running") return "rolling_back";
  if (run.rollbackStatus === "completed") return "rolled_back";
  if (run.rollbackStatus === "failed") return "rollback_failed";
  if (run.kind === "reply" && run.status === "ready") return "answered";
  return run.status;
}

// Lifetime cost chip for the agent tile's foot row. "estimated" gets a "~"
// prefix (token-count pricing, not a vendor-reported figure — see
// lib/model-pricing.ts); an oauth-billed agent additionally reads "incl. in
// subscription" since the dollar figure is notional, not a marginal charge.
// null covers both "no priced run yet" and "no runs at all" — same glyph
// either way, since the tile has no use for distinguishing them.
export function formatAgentCost(agent: Pick<FloorAgent, "costMicroUsd" | "costSource" | "billedKind">): { label: string; title: string } {
  if (agent.costMicroUsd === null || agent.costSource === null) {
    return { label: "—", title: "No priced runs yet" };
  }
  const dollars = (agent.costMicroUsd / 1_000_000).toFixed(2);
  const estimated = agent.costSource !== "reported";
  const amount = `${estimated ? "~" : ""}$${dollars}`;
  const subscription = agent.billedKind === "oauth";
  const label = subscription ? `${amount} · incl. in subscription` : amount;
  const title = [
    "Lifetime cost across every run this agent has made.",
    estimated ? "Estimated from token counts at list prices, not a vendor-reported figure." : "Reported by the provider.",
    subscription ? "Billed to a subscription — no marginal charge for this usage." : null,
  ].filter(Boolean).join(" ");
  return { label, title };
}

export function canRollbackRun(input: {
  run: AgentRun | null | undefined;
  item: import("@/lib/floor-types").FloorQueueItem | null | undefined;
  agent: import("@/lib/floor-types").FloorAgent | null | undefined;
  currentUserId: string;
  sessionOwner: boolean;
}): boolean {
  const { run, item, agent, currentUserId, sessionOwner } = input;
  if (!run || !item || !agent || run.status !== "integrated" || run.kind === "reply") return false;
  if (run.rollbackStatus && run.rollbackStatus !== "failed") return false;
  const authoredEveryPrompt = item.prompts.length > 0 && item.prompts.every((prompt) => prompt.authorUserId === currentUserId);
  return sessionOwner || agent.ownerUserId === currentUserId || authoredEveryPrompt;
}

import type { AgentRun, AgentRunStatus, FloorAgent, FloorQueueItem, MergeConflictStatus } from "@/lib/floor-types";

// The open merge conflict case belonging to one floor agent (source.agentId
// on the case — see db/conflicts.ts), if any. Workspace.tsx builds one of
// these per agent from the review snapshot; AgentCard/AgentSpotlight use it
// to override their ordinary run-status display with conflict state.
export type AgentConflictInfo = { caseId: string; status: MergeConflictStatus };

// Reuses the agent card's existing status-overlay states (see
// legacy-floor-components.css's "Agent status states" block) rather than
// inventing new ones: "needs-input" is the same amber breathing ring already
// used elsewhere for "a person must act," "blocked" is the same red ring
// already used for "stuck." A resolved case stops overriding the card —
// the agent's own latest-run status takes back over once nothing is open.
export function conflictCardStatus(conflict: AgentConflictInfo | null | undefined): "needs-input" | "blocked" | null {
  if (!conflict) return null;
  if (conflict.status === "awaiting_input" || conflict.status === "failed") return "needs-input";
  if (conflict.status === "pending" || conflict.status === "resolving") return "blocked";
  return null;
}

export function conflictStateLabel(status: "needs-input" | "blocked"): string {
  return status === "needs-input" ? "Needs your decision" : "Resolving merge conflict";
}

export type PanelId = "brief" | "floor" | "queue";
export type RailId = Exclude<PanelId, "floor">;
export type AgentLayout = "focus" | "all";
export type WorkspaceScreen = "workspace" | "review";
export type QueueScope = "mine" | "team";
export type QueueOrderMode = "auto" | "manual";
export type TeamPanelView = "goals" | "chat" | "artifacts";
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
export function runStatusToken(run: (Pick<AgentRun, "status" | "kind"> & Partial<Pick<AgentRun, "rollbackStatus" | "completion">>) | null | undefined): string {
  if (!run) return "idle";
  if (run.rollbackStatus === "requested" || run.rollbackStatus === "running") return "rolling_back";
  if (run.rollbackStatus === "completed") return "rolled_back";
  if (run.rollbackStatus === "failed") return "rollback_failed";
  if (run.completion === "no_changes" && run.status === "ready") return "completed";
  if (run.kind === "reply" && run.status === "ready") return "answered";
  return run.status;
}

export function runHandoffLabel(run: Pick<AgentRun, "status" | "kind" | "completion"> | null): string | null {
  if (!run || run.kind === "reply" || run.completion) return null;
  if (run.status === "ready") return "Preparing publication";
  if (run.status === "publishing") return "Publishing changes";
  if (run.status === "published") return "Waiting to integrate";
  if (run.status === "integrating") return "Integrating changes";
  return null;
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

// Compact token count for meters and chips: 850, 12K, 1.2M.
export function formatTokens(count: number): string {
  if (count >= 10_000_000) return `${Math.round(count / 1_000_000)}M`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}

// The spotlight's context meter. Prompt-side totals (fresh input + cache
// reads + cache writes) are summed across the whole run, so against the
// model's window this is an UPPER BOUND on how full the context got — exact
// for a single-turn run, conservative for a multi-turn one. Runs are
// stateless (each rebuilds its prompt), so there is no cross-run context and
// nothing to flush. max is null when the model's window isn't documented in
// MODEL_CONTEXT_TOKENS — callers show the count without a meter.
export function runContextUsage(run: Pick<AgentRun, "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">, windowTokens: number | null): {
  promptTokens: number;
  windowTokens: number | null;
  level: "ok" | "warn" | "over";
  label: string;
  title: string;
} | null {
  if (run.inputTokens === null && run.cacheReadTokens === null && run.cacheWriteTokens === null) return null;
  const promptTokens = (run.inputTokens ?? 0) + (run.cacheReadTokens ?? 0) + (run.cacheWriteTokens ?? 0);
  const ratio = windowTokens ? promptTokens / windowTokens : 0;
  const level = ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok";
  const out = run.outputTokens !== null ? ` · ${formatTokens(run.outputTokens)} out` : "";
  const label = windowTokens
    ? `${formatTokens(promptTokens)} of ${formatTokens(windowTokens)} window${out}`
    : `${formatTokens(promptTokens)} prompt tokens${out}`;
  const title = windowTokens
    ? `Prompt-side tokens across the latest run against ${run.model}'s ${formatTokens(windowTokens)} context window — an upper bound on how full the context got.`
    : `Prompt-side tokens across the latest run. ${run.model}'s context window isn't documented, so no meter is drawn.`;
  return { promptTokens, windowTokens, level, label, title };
}

// Where a click on a queue item's card/status chip should go, derived purely
// from the item and its matched run — no fetch, so PromptQueue can compute it
// per row during render.
export type QueueItemDestination =
  | { kind: "agent"; agentId: string }
  | { kind: "review"; runId: string; status: "active" | "rolled_back" }
  | { kind: "detail" }
  | null;

export function queueItemDestination(item: FloorQueueItem, run: AgentRun | null | undefined): QueueItemDestination {
  // Live (including mid-rollback): jump to the agent actually doing the work.
  // Prefer the run's own agentId — item.agentId can already have moved on for
  // a retargeted item — falling back to item.agentId only if a run somehow
  // carries none (shouldn't happen; agent_id is NOT NULL on agent_runs).
  const liveAgentId = run?.agentId ?? item.agentId;
  if (isRunLive(run) && liveAgentId) return { kind: "agent", agentId: liveAgentId };
  // item.rollback is populated from the item's latest *integrated* task run
  // (db/floor.ts) — the reliable "this prompt landed" signal, independent of
  // getAgentRuns' 20-row window.
  if (item.rollback) return { kind: "review", runId: item.rollback.runId, status: item.rollback.status === "completed" ? "rolled_back" : "active" };
  if (run?.status === "integrated") return { kind: "review", runId: run.id, status: "active" };
  if (run) return { kind: "detail" };
  // item.answer is the same durable source as item.rollback above — a
  // question item stays clickable to its own answer even once the run has
  // aged out of getAgentRuns' 20-row window and no longer shows up as `run`.
  if (item.answer) return { kind: "detail" };
  return null;
}

// Fixed queue sections, top to bottom. Live is not collapsible and keeps
// dispatch order (position ascending — the same order auto-dispatch and
// drag-reorder act on); every other section is a collapsible bar sorted
// newest-first. createdAt is the only stable recency key available in every
// section: reorderFloorQueue bumps updated_at, and terminal runs age out of
// getAgentRuns' 20-row window.
export type QueueGroupId = "live" | "conflicted" | "failed" | "answered" | "completed" | "integrated" | "cancelled";

export const QUEUE_GROUP_ORDER: readonly QueueGroupId[] = ["live", "conflicted", "failed", "answered", "completed", "integrated", "cancelled"];

export const QUEUE_GROUP_LABELS: Record<QueueGroupId, string> = {
  live: "Live",
  conflicted: "Conflicted",
  failed: "Failed",
  answered: "Answered",
  completed: "Completed",
  integrated: "Integrated",
  cancelled: "Cancelled",
};

export type QueueGroup = { id: QueueGroupId; label: string; items: FloorQueueItem[] };

// Buckets one item the same way the queue card computes its status chip:
// a queued/paused item's own state wins over a stale terminal run (the
// resumed-item guard), and item.rollback/item.answer are the durable signals
// that survive the run window. A discarded run folds into Live rather than
// Cancelled — discard leaves the run published and the item parked, which is
// where it already sat before grouping existed.
export function queueItemGroup(item: FloorQueueItem, run: AgentRun | null | undefined): QueueGroupId {
  if (item.status === "queued" || item.status === "paused") return "live";
  if (item.rollback?.status === "requested" || item.rollback?.status === "running") return "live";
  if (item.rollback?.status === "failed" || run?.rollbackStatus === "failed") return "failed";
  if (run?.status === "conflicted") return "conflicted";
  if (run) {
    const token = runStatusToken(run);
    if (token === "failed") return "failed";
    if (token === "answered") return "answered";
    if (token === "completed") return "completed";
    if (token === "integrated" || token === "rolled_back") return "integrated";
    if (token === "cancelled") return "cancelled";
    return "live";
  }
  if (item.answer) return "answered";
  if (item.rollback) return "integrated";
  if (item.status === "completed") return "completed";
  if (item.status === "failed") return "failed";
  if (item.status === "cancelled") return "cancelled";
  return "live";
}

// Applies the mine/team scope filter, buckets the survivors, and returns all
// sections in fixed order. Live sorts by position ascending (dispatch order);
// every other section sorts newest-first by createdAt, id as tie-break.
export function groupQueueItems(
  items: FloorQueueItem[],
  runsByQueueItemId: ReadonlyMap<string, AgentRun>,
  scope: QueueScope,
  currentUserId: string,
): QueueGroup[] {
  const scoped = scope === "mine" ? items.filter((item) => item.prompts.some((prompt) => prompt.authorUserId === currentUserId)) : items;
  const buckets = new Map<QueueGroupId, FloorQueueItem[]>(QUEUE_GROUP_ORDER.map((id) => [id, []]));
  for (const item of scoped) buckets.get(queueItemGroup(item, runsByQueueItemId.get(item.id)))!.push(item);
  return QUEUE_GROUP_ORDER.map((id) => {
    const list = buckets.get(id)!;
    if (id === "live") list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    else list.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return { id, label: QUEUE_GROUP_LABELS[id], items: list };
  });
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

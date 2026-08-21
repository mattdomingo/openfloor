import { getDb, type D1DatabaseLike } from "./index";
import type { StartRunResult } from "@/lib/agent-run-start";

export const GLOBAL_RUN_BUDGET = 5;
export const SESSION_RUN_CAP = 2;

const ACTIVE_RUN_STATUSES = "('provisioning', 'running', 'checking', 'cancel_requested')";

export type RoutingTrigger = "enqueue" | "run_completed" | "toggle" | "agent_changed" | "alarm";

export type TickOutcome = { acted: boolean; held: boolean; revision: number | null };

export type RoutingDeps = {
  startRun: (sessionId: string, queueItemId: string, userId: string) => Promise<StartRunResult>;
};

type AgentRow = {
  id: string;
  name: string;
  role: string;
  task: string;
  createdAt: number;
};

type QueueRow = {
  id: string;
  agentId: string | null;
  assignedBy: "user" | "router" | null;
  position: number;
};

type CandidateSnapshot = {
  agentId: string;
  name: string;
  overlap: number;
  lastRunAt: number | null;
  eligible: boolean;
  why: string;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "onto", "over", "under", "when", "then",
  "than", "them", "they", "you", "your", "our", "are", "was", "were", "will", "would", "should", "could",
  "can", "may", "might", "must", "have", "has", "had", "been", "being", "does", "did", "doing", "not",
  "all", "any", "some", "each", "also", "just", "please", "make", "add", "use", "using", "new", "get",
  "set", "let", "its", "his", "her", "who", "what", "which", "where", "how", "why", "about", "after", "before",
]);

export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

export async function runRoutingTick(
  sessionId: string,
  trigger: RoutingTrigger,
  deps: RoutingDeps,
  database: D1DatabaseLike = getDb(),
): Promise<TickOutcome> {
  const session = await database.prepare(
    "SELECT auto_dispatch AS autoDispatch, ended_at AS endedAt FROM sessions WHERE id = ?",
  ).bind(sessionId).first<{ autoDispatch: number; endedAt: number | null }>();
  if (!session || !session.autoDispatch || session.endedAt !== null) {
    return { acted: false, held: false, revision: null };
  }
  const owner = await database.prepare(
    "SELECT user_id AS userId FROM session_members WHERE session_id = ? AND role = 'owner' AND removed_at IS NULL ORDER BY joined_at, user_id LIMIT 1",
  ).bind(sessionId).first<{ userId: string }>();
  if (!owner) return { acted: false, held: false, revision: null };

  const [queueResult, promptResult, agentResult, activityResult, globalCount] = await Promise.all([
    database.prepare(
      `SELECT id, agent_id AS agentId, assigned_by AS assignedBy, position
       FROM floor_queue_items WHERE session_id = ? AND status = 'queued'
       ORDER BY position, created_at, id`,
    ).bind(sessionId).all<QueueRow>(),
    database.prepare(
      `SELECT p.queue_item_id AS queueItemId, p.text
       FROM floor_queue_prompts p
       JOIN floor_queue_items q ON q.id = p.queue_item_id
       WHERE q.session_id = ? AND q.status = 'queued'
       ORDER BY p.created_at, p.id`,
    ).bind(sessionId).all<{ queueItemId: string; text: string }>(),
    database.prepare(
      `SELECT id, name, role, task, created_at AS createdAt FROM floor_agents
       WHERE session_id = ? ORDER BY created_at, id`,
    ).bind(sessionId).all<AgentRow>(),
    database.prepare(
      `SELECT agent_id AS agentId,
              MAX(created_at) AS lastRunAt,
              SUM(CASE WHEN status IN ${ACTIVE_RUN_STATUSES} THEN 1 ELSE 0 END) AS activeCount
       FROM agent_runs WHERE session_id = ? GROUP BY agent_id`,
    ).bind(sessionId).all<{ agentId: string; lastRunAt: number; activeCount: number }>(),
    database.prepare(
      `SELECT COUNT(*) AS count FROM agent_runs WHERE status IN ${ACTIVE_RUN_STATUSES}`,
    ).first<{ count: number }>(),
  ]);

  const queue = queueResult.results;
  const agents = agentResult.results;
  const promptsByItem = new Map<string, string[]>();
  for (const prompt of promptResult.results) {
    const list = promptsByItem.get(prompt.queueItemId) ?? [];
    list.push(prompt.text);
    promptsByItem.set(prompt.queueItemId, list);
  }
  const lastRunByAgent = new Map<string, number>();
  const busyAgents = new Set<string>();
  let sessionActive = 0;
  for (const row of activityResult.results) {
    lastRunByAgent.set(row.agentId, Number(row.lastRunAt));
    if (Number(row.activeCount) > 0) busyAgents.add(row.agentId);
    sessionActive += Number(row.activeCount);
  }
  const globalActive = Number(globalCount?.count ?? 0);
  const now = Date.now();

  const decisions: Array<{
    queueItemId: string | null;
    agentId: string | null;
    runId: string | null;
    decision: "assigned" | "dispatched" | "held" | "skipped";
    reason: string;
    candidates: CandidateSnapshot[];
  }> = [];
  let changedQueueOrRuns = false;
  let held = false;

  // --- Assign phase: give every unassigned queued item an agent. ---
  const unassigned = queue.filter((item) => item.agentId === null);
  if (unassigned.length > 0 && agents.length === 0) {
    decisions.push({ queueItemId: null, agentId: null, runId: null, decision: "held", reason: "No agents exist in this session", candidates: [] });
    held = true;
  } else if (unassigned.length > 0) {
    const claimedThisTick = new Set<string>();
    for (const item of unassigned) {
      const promptTokens = tokenize((promptsByItem.get(item.id) ?? []).join(" "));
      const candidates: CandidateSnapshot[] = agents.map((agent) => {
        const agentTokens = tokenize(`${agent.role} ${agent.task}`);
        let overlap = 0;
        const matched: string[] = [];
        for (const token of promptTokens) {
          if (agentTokens.has(token)) {
            overlap += 1;
            if (matched.length < 3) matched.push(token);
          }
        }
        const busy = busyAgents.has(agent.id) || claimedThisTick.has(agent.id);
        return {
          agentId: agent.id,
          name: agent.name,
          overlap,
          lastRunAt: lastRunByAgent.get(agent.id) ?? null,
          eligible: !busy,
          why: matched.length > 0 ? `matched: ${matched.join(", ")}` : busy ? "busy" : "idle",
        };
      });
      // Prefer idle agents; fall back to busy ones (assignment is not dispatch).
      const pool = candidates.filter((candidate) => candidate.eligible);
      const ranked = (pool.length > 0 ? pool : candidates).slice().sort((a, b) => {
        if (a.overlap !== b.overlap) return b.overlap - a.overlap;
        const aLast = a.lastRunAt ?? -1;
        const bLast = b.lastRunAt ?? -1;
        if (aLast !== bLast) return aLast - bLast;
        return 0; // stable sort preserves agent creation order (created_at, id)
      });
      const chosen = ranked[0];
      if (!chosen) continue;
      const matchedTokens = chosen.why.startsWith("matched: ") ? chosen.why.slice("matched: ".length) : "";
      const reason = chosen.overlap > 0
        ? `Matched ${chosen.overlap} task keyword(s): ${matchedTokens}`
        : pool.length === 1 && candidates.length > 1
          ? "No keyword match; only idle agent"
          : "No keyword match; least recently used agent";
      const update = await database.prepare(
        `UPDATE floor_queue_items SET agent_id = ?, assigned_by = 'router', assigned_reason = ?, updated_at = ?
         WHERE id = ? AND session_id = ? AND status = 'queued' AND agent_id IS NULL`,
      ).bind(chosen.agentId, reason, now, item.id, sessionId).run();
      if (Number(update.meta?.changes ?? 0) === 0) continue; // a human raced us
      claimedThisTick.add(chosen.agentId);
      item.agentId = chosen.agentId;
      item.assignedBy = "router";
      changedQueueOrRuns = true;
      decisions.push({ queueItemId: item.id, agentId: chosen.agentId, runId: null, decision: "assigned", reason, candidates });
    }
  }

  // --- Dispatch phase: start runs for assigned queued items while capacity allows. ---
  const dispatchable = queue.filter((item) => item.agentId !== null);
  let capacity = Math.min(GLOBAL_RUN_BUDGET - globalActive, SESSION_RUN_CAP - sessionActive);
  if (dispatchable.length === 0) {
    // Nothing waiting; stay quiet even at capacity.
  } else if (capacity <= 0) {
    const reason = SESSION_RUN_CAP - sessionActive <= 0
      ? `Session run cap reached (${sessionActive} active)`
      : "Global run budget reached";
    decisions.push({ queueItemId: null, agentId: null, runId: null, decision: "held", reason, candidates: [] });
    held = true;
  } else {
    const dispatchedAgents = new Set<string>();
    for (const item of dispatchable) {
      if (capacity <= 0) {
        held = true;
        break;
      }
      if (!item.agentId) continue;
      const agent = agents.find((candidate) => candidate.id === item.agentId);
      if (busyAgents.has(item.agentId) || dispatchedAgents.has(item.agentId)) {
        decisions.push({
          queueItemId: item.id, agentId: item.agentId, runId: null, decision: "skipped",
          reason: `Agent ${agent?.name ?? "unknown"} is busy`, candidates: [],
        });
        continue;
      }
      const result = await deps.startRun(sessionId, item.id, owner.userId);
      if (result.ok) {
        dispatchedAgents.add(item.agentId);
        capacity -= 1;
        changedQueueOrRuns = true;
        decisions.push({ queueItemId: item.id, agentId: item.agentId, runId: result.runId, decision: "dispatched", reason: "Agent was idle and capacity was available", candidates: [] });
      } else if (result.kind === "conflict") {
        // Duplicate wake or a manual Run raced us; the unique index already guarded this.
        continue;
      } else {
        // "not_ready" and "disabled" are session-wide preconditions; stop dispatching.
        decisions.push({ queueItemId: item.id, agentId: item.agentId, runId: null, decision: "held", reason: result.message, candidates: [] });
        held = true;
        break;
      }
    }
  }

  if (decisions.length > 0) {
    await database.batch(decisions.map((decision) => database.prepare(
      `INSERT INTO routing_decisions (id, session_id, queue_item_id, agent_id, run_id, decision, reason, candidates, triggered_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), sessionId, decision.queueItemId, decision.agentId, decision.runId,
      decision.decision, decision.reason, JSON.stringify(decision.candidates), trigger, now,
    )));
  }

  let revision: number | null = null;
  if (changedQueueOrRuns) {
    await database.prepare(
      "UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ? AND ended_at IS NULL",
    ).bind(now, sessionId).run();
    const row = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(sessionId).first<{ revision: number }>();
    revision = Number(row?.revision ?? 0);
  }
  return { acted: changedQueueOrRuns, held, revision };
}

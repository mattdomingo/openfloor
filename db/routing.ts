import { getDb, type D1DatabaseLike } from "./index";
import { deprovisionIdleGeneratedAgents, ensureAnswerAgent, ensureWorkerAgent } from "./floor";
import type { StartRunResult } from "@/lib/agent-run-start";
import { getPendingConflict, type PendingConflict } from "./conflicts";
import type { PromptIntent } from "@/lib/floor-types";
import { resolveAutoAgentProvider } from "./provider-credentials";

export const GLOBAL_RUN_BUDGET = 30;
export const SESSION_RUN_CAP = 15;

const ACTIVE_RUN_STATUSES = "('provisioning', 'running', 'checking', 'ready', 'publishing', 'published', 'integrating', 'cancel_requested')";

export type RoutingTrigger = "enqueue" | "run_completed" | "toggle" | "agent_changed" | "alarm";

export type TickOutcome = { acted: boolean; held: boolean; revision: number | null };

export type RoutingDeps = {
  startRun: (sessionId: string, queueItemId: string, userId: string, kind: "task" | "reply") => Promise<StartRunResult>;
  startConflictResolution?: (conflict: PendingConflict) => Promise<StartRunResult>;
  // Providers whose runs cannot start right now (rollout gates, e.g.
  // CLAUDE_RUN_ENABLED=false). Items targeting these agents are SKIPPED like
  // busy agents — never held — because a "disabled" StartRunResult from the
  // seam is treated as a session-wide precondition and would halt dispatch
  // of every other provider's items behind it, backing off for a condition
  // that only resolves when an operator flips a Worker var.
  disabledProviders?: ReadonlySet<string>;
};

type AgentRow = {
  id: string;
  name: string;
  role: string;
  task: string;
  provider: string;
  kind: "answer" | "worker" | null;
  createdAt: number;
};

type QueueRow = {
  id: string;
  agentId: string | null;
  assignedBy: "user" | "router" | null;
  intent: PromptIntent | null;
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

// Whole-string only, checked before task verbs so a real request that
// happens to contain one of these words ("ping the health endpoint") never
// gets misread as noise — only a bare greeting/acknowledgement does.
const NOISE_PHRASES = new Set([
  "ping", "hi", "hello", "hey", "yo", "thanks", "thank you", "ty", "ok", "okay", "test", "👋",
]);

// Checked before the question test: "can you fix the login bug?" has both an
// interrogative opener and a trailing "?", but the verb makes it a task.
const TASK_VERBS = new Set([
  "add", "fix", "implement", "refactor", "write", "create", "update", "remove", "delete",
  "rename", "migrate", "build", "bump", "upgrade",
]);

const INTERROGATIVES = new Set([
  "what", "why", "how", "who", "when", "where", "which", "is", "are", "do", "does", "did",
  "can", "could", "should", "would", "will",
]);

export function classifyPrompt(text: string): PromptIntent {
  const normalized = text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized.length === 0) return "task";

  const strippedOfPunctuation = normalized.replace(/[.,!?;:]+$/, "");
  if (NOISE_PHRASES.has(strippedOfPunctuation)) return "noise";

  const words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((word) => TASK_VERBS.has(word))) return "task";

  if (normalized.endsWith("?") || INTERROGATIVES.has(words[0] ?? "")) return "question";

  return "task";
}

export async function runRoutingTick(
  sessionId: string,
  trigger: RoutingTrigger,
  deps: RoutingDeps,
  database: D1DatabaseLike = getDb(),
): Promise<TickOutcome> {
  const session = await database.prepare(
    "SELECT auto_dispatch AS autoDispatch, auto_provision_agents AS autoProvisionAgents, auto_resolve_conflicts AS autoResolveConflicts, ended_at AS endedAt FROM sessions WHERE id = ?",
  ).bind(sessionId).first<{ autoDispatch: number; autoProvisionAgents: number; autoResolveConflicts: number; endedAt: number | null }>();
  if (!session || session.endedAt !== null) {
    return { acted: false, held: false, revision: null };
  }
  const owner = await database.prepare(
    "SELECT user_id AS userId FROM session_members WHERE session_id = ? AND role = 'owner' AND removed_at IS NULL ORDER BY joined_at, user_id LIMIT 1",
  ).bind(sessionId).first<{ userId: string }>();
  if (!owner) return { acted: false, held: false, revision: null };
  const ownerUserId = owner.userId;

  // Conflict resolution is a separate automation from ordinary dispatch.
  // An eligible case gets the next available slot, but a busy inherited
  // agent or gated provider is not eligible and therefore cannot freeze
  // unrelated ordinary work.
  const pendingConflict = await getPendingConflict(sessionId, database);
  if (pendingConflict && deps.startConflictResolution && !(deps.disabledProviders?.has(pendingConflict.agentProvider) ?? false)) {
    const [agentActive, sessionCount, globalCount] = await Promise.all([
      database.prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE agent_id = ? AND status IN ${ACTIVE_RUN_STATUSES}`)
        .bind(pendingConflict.agentId).first<{ count: number }>(),
      database.prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE session_id = ? AND status IN ${ACTIVE_RUN_STATUSES}`)
        .bind(sessionId).first<{ count: number }>(),
      database.prepare(`SELECT COUNT(*) AS count FROM agent_runs WHERE status IN ${ACTIVE_RUN_STATUSES}`)
        .first<{ count: number }>(),
    ]);
    const sessionActive = Number(sessionCount?.count ?? 0);
    const globalActive = Number(globalCount?.count ?? 0);
    if (Number(agentActive?.count ?? 0) === 0) {
      if (sessionActive >= SESSION_RUN_CAP || globalActive >= GLOBAL_RUN_BUDGET) {
        return { acted: false, held: true, revision: null };
      }
      const result = await deps.startConflictResolution(pendingConflict);
      if (result.ok) {
        const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
          .bind(sessionId).first<{ revision: number }>();
        return { acted: true, held: false, revision: Number(revision?.revision ?? 0) };
      }
      // A stable conflict-specific condition (provider/quota/race/readiness)
      // leaves the case visible but must not halt other agents' queued work.
    }
  }
  const lifecycleChanged = await deprovisionIdleGeneratedAgents(sessionId, Boolean(session.autoProvisionAgents), database);
  if (!session.autoDispatch) {
    if (!lifecycleChanged) return { acted: false, held: false, revision: null };
    const now = Date.now();
    await database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ? AND ended_at IS NULL").bind(now, sessionId).run();
    const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(sessionId).first<{ revision: number }>();
    return { acted: true, held: false, revision: Number(revision?.revision ?? 0) };
  }

  const providerResolution = session.autoProvisionAgents
    ? await resolveAutoAgentProvider(
        sessionId,
        database,
        deps.disabledProviders as ReadonlySet<import("@/lib/provider-credentials").CredentialProvider> | undefined,
      )
    : null;
  const generatedProvider = providerResolution?.effectiveProvider ?? null;
  const providerDisabled = generatedProvider ? (deps.disabledProviders?.has(generatedProvider) ?? false) : false;
  const canProvision = Boolean(session.autoProvisionAgents && generatedProvider && !providerDisabled);

  const [queueResult, promptResult, agentResult, activityResult, globalCount] = await Promise.all([
    database.prepare(
      `SELECT id, agent_id AS agentId, assigned_by AS assignedBy, intent, position
       FROM floor_queue_items WHERE session_id = ? AND status = 'queued' AND dismissed_at IS NULL
       ORDER BY position, created_at, id`,
    ).bind(sessionId).all<QueueRow>(),
    database.prepare(
      `SELECT p.queue_item_id AS queueItemId, p.text
       FROM floor_queue_prompts p
       JOIN floor_queue_items q ON q.id = p.queue_item_id
       WHERE q.session_id = ? AND q.status = 'queued' AND q.dismissed_at IS NULL
       ORDER BY p.created_at, p.id`,
    ).bind(sessionId).all<{ queueItemId: string; text: string }>(),
    database.prepare(
      `SELECT id, name, role, task, provider, kind, created_at AS createdAt FROM floor_agents
       WHERE session_id = ? AND deprovisioned_at IS NULL AND paused_at IS NULL ORDER BY created_at, id`,
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
  let changedQueueOrRuns = lifecycleChanged;
  let held = false;

  // Every queued item's intent, computed once whether or not it was already
  // assigned — a targeted item ("@Rex what's the status?") still needs an
  // intent so the dispatch phase below can pick a reply run over a task run.
  const intentByItem = new Map<string, PromptIntent>();
  for (const item of queue) {
    intentByItem.set(item.id, item.intent ?? classifyPrompt((promptsByItem.get(item.id) ?? []).join(" ")));
  }
  let answerAgentId: string | null = agents.find((agent) => agent.kind === "answer")?.id ?? null;
  async function resolveAnswerAgent(): Promise<string | null> {
    if (!canProvision || !generatedProvider) return null;
    if (!answerAgentId) {
      const provisioned = await ensureAnswerAgent(sessionId, ownerUserId, generatedProvider, database);
      answerAgentId = provisioned.id;
      if (provisioned.changed) {
        changedQueueOrRuns = true;
        agents.push({ id: provisioned.id, name: provisioned.name, role: "Session answers", task: "Answer questions about this session and its repository.", provider: generatedProvider, kind: "answer", createdAt: now });
      }
    }
    return answerAgentId;
  }

  // --- Assign phase: give every unassigned queued item an agent. ---
  const unassigned = queue.filter((item) => item.agentId === null);
  const taskAgents = agents.filter((agent) => agent.kind !== "answer");
  const routingCapacity = Math.max(0, Math.min(SESSION_RUN_CAP - sessionActive, GLOBAL_RUN_BUDGET - globalActive));
  if (unassigned.length > 0) {
    // Existing targeted/router assignments get the first available slots.
    // Seeding the set prevents us from provisioning workers that cannot
    // dispatch in this tick, and also keeps another item off the same agent.
    const claimedThisTick = new Set(
      queue
        .filter((item) => item.agentId && !busyAgents.has(item.agentId))
        .filter((item) => {
          const agent = agents.find((candidate) => candidate.id === item.agentId);
          return !agent || !(deps.disabledProviders?.has(agent.provider) ?? false);
        })
        .map((item) => item.agentId!),
    );
    for (const item of unassigned) {
      const intent = intentByItem.get(item.id) ?? "task";

      if (intent !== "task") {
        const agentId = await resolveAnswerAgent();
        if (!agentId) {
          const reason = providerResolution?.state === "selection_required"
            ? "Choose a default generated-agent provider"
            : providerDisabled
              ? "The generated-agent provider is not enabled"
              : "Automatic agent provisioning is off";
          decisions.push({ queueItemId: item.id, agentId: null, runId: null, decision: "held", reason, candidates: [] });
          held = true;
          continue;
        }
        const reason = intent === "question"
          ? "Question — routed to the session answer agent"
          : "Not a task — routed to the session answer agent";
        const update = await database.prepare(
          `UPDATE floor_queue_items SET agent_id = ?, assigned_by = 'router', assigned_reason = ?, intent = ?, updated_at = ?
           WHERE id = ? AND session_id = ? AND status = 'queued' AND agent_id IS NULL`,
        ).bind(agentId, reason, intent, now, item.id, sessionId).run();
        if (Number(update.meta?.changes ?? 0) === 0) continue; // a human raced us
        item.agentId = agentId;
        item.assignedBy = "router";
        item.intent = intent;
        claimedThisTick.add(agentId);
        changedQueueOrRuns = true;
        decisions.push({ queueItemId: item.id, agentId, runId: null, decision: "assigned", reason, candidates: [] });
        continue;
      }

      let availableAgents = taskAgents;

      const promptTokens = tokenize((promptsByItem.get(item.id) ?? []).join(" "));
      let candidates: CandidateSnapshot[] = availableAgents.map((agent) => {
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
        const providerDisabled = deps.disabledProviders?.has(agent.provider) ?? false;
        return {
          agentId: agent.id,
          name: agent.name,
          overlap,
          lastRunAt: lastRunByAgent.get(agent.id) ?? null,
          eligible: !busy && !providerDisabled,
          why: matched.length > 0 ? `matched: ${matched.join(", ")}` : busy ? "busy" : providerDisabled ? "provider disabled" : "idle",
        };
      });
      // Persistent agents are the first elastic tier. Only when every
      // persistent/generated task agent is occupied do we activate a worker.
      let pool = candidates.filter((candidate) => candidate.eligible);
      const persistentPool = pool.filter((candidate) => availableAgents.find((agent) => agent.id === candidate.agentId)?.kind === null);
      if (persistentPool.length > 0) pool = persistentPool;
      if (pool.length === 0 && canProvision && generatedProvider && claimedThisTick.size < routingCapacity) {
        const task = (promptsByItem.get(item.id) ?? []).join(" ").slice(0, 1_000);
        const provisioned = await ensureWorkerAgent(sessionId, ownerUserId, generatedProvider, task, database);
        const worker: AgentRow = { id: provisioned.id, name: provisioned.name, role: "Auto-provisioned engineer", task, provider: generatedProvider, kind: "worker", createdAt: now };
        availableAgents = [...availableAgents, worker];
        taskAgents.push(worker);
        agents.push(worker);
        candidates = [...candidates, { agentId: worker.id, name: worker.name, overlap: 0, lastRunAt: null, eligible: true, why: "auto-provisioned" }];
        pool = [candidates[candidates.length - 1]];
        if (provisioned.changed) changedQueueOrRuns = true;
      }
      if (pool.length === 0) {
        const reason = taskAgents.length === 0 && !session.autoProvisionAgents
          ? "No agents exist in this session"
          : providerResolution?.state === "selection_required"
            ? "Choose a default generated-agent provider"
            : providerDisabled
              ? "The generated-agent provider is not enabled"
              : "No idle agent or automatic run capacity is available";
        decisions.push({ queueItemId: item.id, agentId: null, runId: null, decision: "held", reason, candidates });
        held = true;
        continue;
      }
      const ranked = pool.slice().sort((a, b) => {
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
        : chosen.why === "auto-provisioned"
          ? "Auto-provisioned for this task"
          : pool.length === 1 && candidates.length > 1
          ? "No keyword match; only idle agent"
          : "No keyword match; least recently used agent";
      const update = await database.prepare(
        `UPDATE floor_queue_items SET agent_id = ?, assigned_by = 'router', assigned_reason = ?, intent = ?, updated_at = ?
         WHERE id = ? AND session_id = ? AND status = 'queued' AND agent_id IS NULL`,
      ).bind(chosen.agentId, reason, intent, now, item.id, sessionId).run();
      if (Number(update.meta?.changes ?? 0) === 0) continue; // a human raced us
      claimedThisTick.add(chosen.agentId);
      item.agentId = chosen.agentId;
      item.assignedBy = "router";
      item.intent = intent;
      changedQueueOrRuns = true;
      decisions.push({ queueItemId: item.id, agentId: chosen.agentId, runId: null, decision: "assigned", reason, candidates });
    }
  }

  // --- Intent backfill: a user-targeted item skips the assign phase above
  // (its agent choice is never overridden — "that agent answers in its own
  // voice") but still needs intent recorded before dispatch decides task vs
  // reply run. Covers items targeted at creation and pre-existing rows from
  // before this column existed. ---
  for (const item of queue) {
    if (item.agentId === null || item.intent !== null) continue;
    const intent = intentByItem.get(item.id) ?? "task";
    await database.prepare(
      `UPDATE floor_queue_items SET intent = ?, updated_at = ? WHERE id = ? AND session_id = ? AND intent IS NULL`,
    ).bind(intent, now, item.id, sessionId).run();
    item.intent = intent;
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
      if (!agent) {
        // Assigned before it went paused/deprovisioned — the query above
        // already excludes such agents from `agents`, so a lookup miss here
        // means "no longer eligible", not "unknown". Must not fall through
        // to startRun below, which has no such guard of its own.
        decisions.push({ queueItemId: item.id, agentId: item.agentId, runId: null, decision: "skipped", reason: "Agent is paused or no longer on the floor", candidates: [] });
        continue;
      }
      if (busyAgents.has(item.agentId) || dispatchedAgents.has(item.agentId)) {
        decisions.push({
          queueItemId: item.id, agentId: item.agentId, runId: null, decision: "skipped",
          reason: `Agent ${agent?.name ?? "unknown"} is busy`, candidates: [],
        });
        continue;
      }
      // A gated provider is a per-item condition, not a session-wide one:
      // skip and keep dispatching the rest of the queue (see RoutingDeps).
      if (agent && deps.disabledProviders?.has(agent.provider)) {
        decisions.push({
          queueItemId: item.id, agentId: item.agentId, runId: null, decision: "skipped",
          reason: `Agent ${agent.name}'s provider (${agent.provider}) is not enabled`, candidates: [],
        });
        continue;
      }
      const runKind = agent?.kind === "answer" || (item.intent !== "task" && item.intent !== null) ? "reply" : "task";
      const result = await deps.startRun(sessionId, item.id, owner.userId, runKind);
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

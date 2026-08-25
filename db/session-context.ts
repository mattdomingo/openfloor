import {
  renderSessionContext,
  type SessionContextAgent,
  type SessionContextAssignment,
  type SessionContextChatMessage,
  type SessionContextPriorAttempt,
  type SessionContextPrompt,
  type SessionContextQueueItem,
  type SessionContextRun,
  type SessionContextSnapshot,
  type SessionContextViewer,
} from "@/lib/session-context";
import { getDb, type D1DatabaseLike } from "./index";
import { getRunExecutionContext } from "./runs";

// Every dispatched agent gets the same brief, built from this reader.
// Deliberately session-scoped with no userId: direct messages must never be
// eligible for inclusion, so the chat query below is hard-coded to the
// public channel (recipient_user_id IS NULL) rather than filtered by viewer,
// the way getFloorSnapshot's member-facing query is. Bounded, fixed number
// of queries — never N+1 over agents, runs, or queue items.

const RUN_LIMIT = 40;
const QUEUE_LIMIT = 40;
const CHAT_LIMIT = 30;
const AGENT_LIMIT = 50;

const IN_FLIGHT_STATUSES = new Set(["provisioning", "running", "checking", "ready", "publishing", "published", "integrating", "cancel_requested"]);
const BLOCKED_STATUSES = new Set(["conflicted", "failed"]);

type RunRow = {
  id: string;
  queueItemId: string;
  agentName: string;
  status: string;
  summary: string | null;
  conflictReason: string | null;
};

export async function getSessionContext(
  sessionId: string,
  viewer?: { runId: string; queueItemId: string },
  database: D1DatabaseLike = getDb(),
): Promise<SessionContextSnapshot | null> {
  const session = await database.prepare("SELECT title, objective FROM sessions WHERE id = ?")
    .bind(sessionId).first<{ title: string; objective: string | null }>();
  if (!session) return null;

  const [connection, candidate, agentRows, assignmentRows, runRows, queueRows, chatRows, priorAttemptRows] = await Promise.all([
    database.prepare("SELECT repository_full_name AS fullName, base_branch AS baseBranch FROM repository_connections WHERE session_id = ?")
      .bind(sessionId).first<{ fullName: string; baseBranch: string }>(),
    database.prepare(
      "SELECT branch_name AS branchName, candidate_sha AS sha, pull_request_number AS pullRequestNumber FROM repository_candidates WHERE session_id = ? AND status = 'active' AND merged_at IS NULL",
    ).bind(sessionId).first<{ branchName: string; sha: string | null; pullRequestNumber: number | null }>(),
    database.prepare(
      `SELECT a.id, a.name, a.role, a.task, owner.display_name AS ownerName
       FROM floor_agents a JOIN users owner ON owner.id = a.owner_user_id
       WHERE a.session_id = ? ORDER BY a.created_at, a.id LIMIT ?`,
    ).bind(sessionId, AGENT_LIMIT).all<SessionContextAgent>(),
    database.prepare(
      `SELECT u.display_name AS userName, fa.task
       FROM floor_assignments fa JOIN users u ON u.id = fa.user_id
       WHERE fa.session_id = ? AND fa.task IS NOT NULL`,
    ).bind(sessionId).all<SessionContextAssignment>(),
    database.prepare(
      `SELECT r.id, r.queue_item_id AS queueItemId, a.name AS agentName, r.status, r.summary,
              r.conflict_reason AS conflictReason
       FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id
       WHERE r.session_id = ? ORDER BY r.created_at DESC LIMIT ?`,
    ).bind(sessionId, RUN_LIMIT).all<RunRow>(),
    database.prepare(
      `SELECT q.id, q.position, q.status, q.agent_id AS agentId, a.name AS agentName, q.assigned_reason AS assignedReason
       FROM floor_queue_items q LEFT JOIN floor_agents a ON a.id = q.agent_id
       WHERE q.session_id = ? AND q.status != 'completed' AND q.dismissed_at IS NULL ORDER BY q.position LIMIT ?`,
    ).bind(sessionId, QUEUE_LIMIT).all<{ id: string; position: number; status: string; agentId: string | null; agentName: string | null; assignedReason: string | null }>(),
    database.prepare(
      `SELECT u.display_name AS authorName, m.text
       FROM floor_messages m JOIN users u ON u.id = m.author_user_id
       WHERE m.session_id = ? AND m.recipient_user_id IS NULL
       ORDER BY m.created_at DESC LIMIT ?`,
    ).bind(sessionId, CHAT_LIMIT).all<SessionContextChatMessage>(),
    viewer
      ? database.prepare(
          `SELECT attempt, status, conflict_reason AS conflictReason FROM agent_runs
           WHERE queue_item_id = ? AND id != ? ORDER BY attempt`,
        ).bind(viewer.queueItemId, viewer.runId).all<SessionContextPriorAttempt>()
      : Promise.resolve({ results: [] as SessionContextPriorAttempt[] }),
  ]);

  const runIds = runRows.results.map((run) => run.id);
  const queueItemIds = [...new Set([...runRows.results.map((run) => run.queueItemId), ...queueRows.results.map((item) => item.id)])];

  const [fileRows, editRows, promptRows] = await Promise.all([
    runIds.length > 0
      ? database.prepare(`SELECT run_id AS runId, path FROM agent_run_files WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY run_id, path`)
          .bind(...runIds).all<{ runId: string; path: string }>()
      : Promise.resolve({ results: [] as Array<{ runId: string; path: string }> }),
    runIds.length > 0
      ? database.prepare(`SELECT run_id AS runId, detail FROM agent_run_events WHERE kind = 'file_edit' AND run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY sequence DESC LIMIT 200`)
          .bind(...runIds).all<{ runId: string; detail: string }>()
      : Promise.resolve({ results: [] as Array<{ runId: string; detail: string }> }),
    queueItemIds.length > 0
      ? database.prepare(
          `SELECT p.queue_item_id AS queueItemId, u.display_name AS authorName, p.text
           FROM floor_queue_prompts p JOIN users u ON u.id = p.author_user_id
           WHERE p.queue_item_id IN (${queueItemIds.map(() => "?").join(",")}) ORDER BY p.created_at`,
        ).bind(...queueItemIds).all<{ queueItemId: string; authorName: string; text: string }>()
      : Promise.resolve({ results: [] as Array<{ queueItemId: string; authorName: string; text: string }> }),
  ]);

  const filesByRun = new Map<string, string[]>();
  for (const row of fileRows.results) filesByRun.set(row.runId, [...(filesByRun.get(row.runId) ?? []), row.path]);

  const editsByRun = new Map<string, string[]>();
  for (const row of editRows.results) editsByRun.set(row.runId, [...(editsByRun.get(row.runId) ?? []), row.detail]);

  const promptsByQueueItem = new Map<string, SessionContextPrompt[]>();
  for (const row of promptRows.results) {
    promptsByQueueItem.set(row.queueItemId, [...(promptsByQueueItem.get(row.queueItemId) ?? []), { authorName: row.authorName, text: row.text }]);
  }

  const integratedRuns: SessionContextRun[] = [];
  const inFlightRuns: SessionContextRun[] = [];
  const blockedRuns: SessionContextRun[] = [];
  for (const run of runRows.results) {
    if (viewer && run.id === viewer.runId) continue;
    const rendered: SessionContextRun = {
      id: run.id,
      agentName: run.agentName,
      status: run.status,
      summary: run.summary,
      conflictReason: run.conflictReason,
      prompts: promptsByQueueItem.get(run.queueItemId) ?? [],
      files: filesByRun.get(run.id) ?? [],
      recentEdits: editsByRun.get(run.id) ?? [],
    };
    if (run.status === "integrated") integratedRuns.push(rendered);
    else if (IN_FLIGHT_STATUSES.has(run.status)) inFlightRuns.push(rendered);
    else if (BLOCKED_STATUSES.has(run.status)) blockedRuns.push(rendered);
  }

  const queue: SessionContextQueueItem[] = queueRows.results.map((item) => ({
    id: item.id,
    position: Number(item.position),
    status: item.status,
    agentName: item.agentName,
    assignedReason: item.assignedReason,
    prompts: promptsByQueueItem.get(item.id) ?? [],
  }));

  return {
    session: { title: session.title, objective: session.objective },
    repository: connection ?? null,
    candidate: candidate ?? null,
    agents: agentRows.results,
    assignments: assignmentRows.results,
    queue,
    integratedRuns,
    inFlightRuns,
    blockedRuns,
    priorAttempts: priorAttemptRows.results,
    chat: [...chatRows.results].reverse(),
  };
}

type RunExecutionContext = NonNullable<Awaited<ReturnType<typeof getRunExecutionContext>>>;

export function viewerFromRunContext(context: RunExecutionContext): SessionContextViewer {
  return {
    agentId: context.agentId,
    agentName: context.agentName,
    agentRole: context.agentRole,
    agentTask: context.agentTask,
    runId: context.id,
    queueItemId: context.queueItemId,
    attempt: context.attempt,
    candidateSha: context.candidateSha,
  };
}

export type RunBrief = {
  text: string;
  status: RunExecutionContext["status"];
  sessionId: string;
  repositoryId: string;
  candidateSha: string;
};

/**
 * Renders the same brief a dispatched agent receives at launch, for a live
 * re-read mid-run. Used by the /runtime/run/context route, which the
 * openfloor MCP tool calls — unlike that route's other hot-path neighbors
 * (events, source, openai), this one is invoked only when the agent
 * deliberately re-reads the floor, so the fuller getRunExecutionContext read
 * is the right cost/correctness tradeoff over the slim getRunGatewayContext.
 * Returns the run's current sessionId/repositoryId/candidateSha alongside the
 * text so the caller can cross-check them against signed token claims before
 * responding, the same defense-in-depth the other gateway routes apply.
 */
export async function renderRunBrief(runId: string, database: D1DatabaseLike = getDb()): Promise<RunBrief | null> {
  const context = await getRunExecutionContext(runId, database);
  if (!context) return null;
  const snapshot = await getSessionContext(context.sessionId, { runId: context.id, queueItemId: context.queueItemId }, database);
  if (!snapshot) return null;
  return {
    text: renderSessionContext(snapshot, viewerFromRunContext(context)),
    status: context.status,
    sessionId: context.sessionId,
    repositoryId: context.repositoryId,
    candidateSha: context.candidateSha,
  };
}

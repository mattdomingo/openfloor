// D1 half of PR feedback nudges (lib/candidate-feedback.ts orchestrates,
// lib/pr-feedback.ts decides). Nudges are ordinary floor_queue_items with
// `origin` set, so dispatch, capacity, pause semantics, and attribution all
// stay exactly what they are for human prompts.
import { parseFeedbackNudgeState, type FeedbackKind, type FeedbackNudgeState, type PlannedNudge } from "@/lib/pr-feedback";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { getDb } from "./index";

export type CandidateFeedbackContext = {
  sessionId: string;
  candidateId: string;
  ownerUserId: string;
  installationId: string;
  repository: GitHubRepositoryOption;
  pullRequestNumber: number;
  // Raw stored JSON — the compare-and-set in recordFeedbackNudges matches on it.
  feedbackNudges: string | null;
  reviewDecision: string | null;
  // Kinds whose most recent nudge item is still queued/running/blocked.
  liveKinds: Set<FeedbackKind>;
  // Kinds whose most recent nudge item is still queued (unstarted) and can
  // take a newer message in place instead of spawning a second item.
  reusableItems: Map<FeedbackKind, string>;
};

// Null under every skip condition: no live candidate/PR, PR closed or
// merged, connection not ready, session ended, or the owner toggle off.
export async function getCandidateFeedbackContext(sessionId: string, database = getDb()): Promise<CandidateFeedbackContext | null> {
  const row = await database.prepare(
    `SELECT c.id AS candidateId, c.pull_request_number AS pullRequestNumber, c.feedback_nudges AS feedbackNudges,
            c.review_decision AS reviewDecision,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId, rc.repository_node_id AS repositoryNodeId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName, rc.repository_full_name AS repositoryFullName,
            rc.repository_private AS repositoryPrivate, rc.default_branch AS defaultBranch,
            m.user_id AS ownerUserId
     FROM sessions s
     JOIN repository_candidates c ON c.session_id = s.id AND c.status = 'active' AND c.merged_at IS NULL AND c.abandoned_at IS NULL
     JOIN repository_connections rc ON rc.id = c.connection_id AND rc.status = 'ready'
     JOIN session_members m ON m.session_id = s.id AND m.role = 'owner' AND m.removed_at IS NULL
     WHERE s.id = ? AND s.ended_at IS NULL AND s.auto_inject_feedback = 1
       AND c.pull_request_number IS NOT NULL
       AND COALESCE(c.pull_request_state, 'open') = 'open' AND COALESCE(c.pull_request_merged, 0) = 0`,
  ).bind(sessionId).first<{
    candidateId: string; pullRequestNumber: number; feedbackNudges: string | null; reviewDecision: string | null;
    installationId: string; repositoryId: string; repositoryNodeId: string; repositoryOwner: string; repositoryName: string;
    repositoryFullName: string; repositoryPrivate: number; defaultBranch: string; ownerUserId: string;
  }>();
  if (!row) return null;
  const live = await database.prepare(
    `SELECT id, origin, status FROM floor_queue_items
     WHERE session_id = ? AND origin IS NOT NULL AND status IN ('queued', 'running', 'blocked') AND dismissed_at IS NULL`,
  ).bind(sessionId).all<{ id: string; origin: FeedbackKind; status: string }>();
  const previous = parseFeedbackNudgeState(row.feedbackNudges);
  const liveKinds = new Set<FeedbackKind>();
  const reusableItems = new Map<FeedbackKind, string>();
  for (const item of live.results) {
    liveKinds.add(item.origin);
    if (item.status === "queued" && previous[item.origin]?.queueItemId === item.id) reusableItems.set(item.origin, item.id);
  }
  return {
    sessionId,
    candidateId: row.candidateId,
    ownerUserId: row.ownerUserId,
    installationId: row.installationId,
    repository: {
      id: row.repositoryId, nodeId: row.repositoryNodeId, owner: row.repositoryOwner, name: row.repositoryName,
      fullName: row.repositoryFullName, private: Boolean(row.repositoryPrivate), defaultBranch: row.defaultBranch,
    },
    pullRequestNumber: Number(row.pullRequestNumber),
    feedbackNudges: row.feedbackNudges,
    reviewDecision: row.reviewDecision,
    liveKinds,
    reusableItems,
  };
}

type ResponsibleRow = { runId: string; agentId: string; pausedAt: number | null; deprovisionedAt: number | null };

// Who should act on the feedback: the agent whose integrated, non-rolled-back
// run most recently touched one of `paths` (review kinds), else the newest
// integrated run (CI, or comments on paths no run touched). The run id is
// returned even when its agent is paused/deprovisioned — the queue item then
// goes out unassigned for the router, but still names the run to resume.
export async function resolveFeedbackAgent(
  sessionId: string,
  candidateId: string,
  paths: string[] | null,
  database = getDb(),
): Promise<{ runId: string; agentId: string | null } | null> {
  const bounded = (paths ?? []).slice(0, 50);
  const notRolledBack = "NOT EXISTS (SELECT 1 FROM agent_run_rollbacks rb WHERE rb.run_id = r.id AND rb.status = 'completed')";
  const byPath = bounded.length > 0
    ? await database.prepare(
        `SELECT r.id AS runId, r.agent_id AS agentId, a.paused_at AS pausedAt, a.deprovisioned_at AS deprovisionedAt
         FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id JOIN agent_run_files f ON f.run_id = r.id
         WHERE r.session_id = ? AND r.candidate_id = ? AND r.status = 'integrated' AND r.kind IS NULL
           AND f.path IN (${bounded.map(() => "?").join(",")}) AND ${notRolledBack}
         ORDER BY r.integrated_at DESC, r.id DESC LIMIT 1`,
      ).bind(sessionId, candidateId, ...bounded).first<ResponsibleRow>()
    : null;
  const row = byPath ?? await database.prepare(
    `SELECT r.id AS runId, r.agent_id AS agentId, a.paused_at AS pausedAt, a.deprovisioned_at AS deprovisionedAt
     FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id
     WHERE r.session_id = ? AND r.candidate_id = ? AND r.status = 'integrated' AND r.kind IS NULL AND ${notRolledBack}
     ORDER BY r.integrated_at DESC, r.id DESC LIMIT 1`,
  ).bind(sessionId, candidateId).first<ResponsibleRow>();
  if (!row) return null;
  return { runId: row.runId, agentId: row.pausedAt === null && row.deprovisionedAt === null ? row.agentId : null };
}

export type FeedbackNudgeEntry = { nudge: PlannedNudge; agentId: string | null; sourceRunId: string | null; reuseQueueItemId: string | null };

const ASSIGNED_REASONS: Record<FeedbackKind, string> = {
  ci_failure: "CI failed on the candidate PR after this agent's integration",
  review_comments: "A reviewer commented on a path this agent last changed",
  changes_requested: "Changes were requested on the candidate PR after this agent's integration",
};

// One batch: compare-and-set the dedup state, then insert (or update in
// place) the nudge items and their owner-attributed prompts, each guarded on
// that same new state so the loser of a concurrent delivery writes nothing.
export async function recordFeedbackNudges(
  context: CandidateFeedbackContext,
  entries: FeedbackNudgeEntry[],
  next: FeedbackNudgeState,
  reviewDecision: string | null,
  database = getDb(),
): Promise<{ revision: number; created: boolean }> {
  const now = Date.now();
  const last = await database.prepare(
    "SELECT COALESCE(MAX(position), 0) AS position FROM floor_queue_items WHERE session_id = ? AND dismissed_at IS NULL",
  ).bind(context.sessionId).first<{ position: number }>();
  let position = Number(last?.position ?? 0);
  const state: FeedbackNudgeState = { ...next };
  const itemIds = new Map<FeedbackKind, string>();
  for (const entry of entries) {
    const id = entry.reuseQueueItemId ?? crypto.randomUUID();
    itemIds.set(entry.nudge.kind, id);
    const record = state[entry.nudge.kind];
    if (record) state[entry.nudge.kind] = { ...record, queueItemId: id };
  }
  const nextJson = JSON.stringify(state);
  const guard = "EXISTS (SELECT 1 FROM repository_candidates WHERE id = ? AND feedback_nudges = ?)";
  const statements = [
    database.prepare(
      "UPDATE repository_candidates SET feedback_nudges = ?, review_decision = ?, updated_at = ? WHERE id = ? AND feedback_nudges IS ?",
    ).bind(nextJson, reviewDecision, now, context.candidateId, context.feedbackNudges),
  ];
  for (const entry of entries) {
    const id = itemIds.get(entry.nudge.kind)!;
    const reason = ASSIGNED_REASONS[entry.nudge.kind];
    if (entry.reuseQueueItemId) {
      statements.push(
        database.prepare(
          `UPDATE floor_queue_prompts SET text = ? WHERE queue_item_id = ?
           AND EXISTS (SELECT 1 FROM floor_queue_items WHERE id = ? AND status = 'queued' AND dismissed_at IS NULL) AND ${guard}`,
        ).bind(entry.nudge.message, id, id, context.candidateId, nextJson),
        database.prepare(
          `UPDATE floor_queue_items SET
             agent_id = COALESCE(agent_id, ?),
             assigned_by = CASE WHEN agent_id IS NULL AND ? IS NOT NULL THEN 'router' ELSE assigned_by END,
             assigned_reason = CASE WHEN agent_id IS NULL AND ? IS NOT NULL THEN ? ELSE assigned_reason END,
             source_run_id = COALESCE(?, source_run_id), updated_at = ?
           WHERE id = ? AND status = 'queued' AND ${guard}`,
        ).bind(entry.agentId, entry.agentId, entry.agentId, reason, entry.sourceRunId, now, id, context.candidateId, nextJson),
      );
    } else {
      position += 1;
      statements.push(
        // intent is pinned to 'task' so a comment body ending in "?" can never
        // route the nudge to the Concierge as a read-only reply.
        database.prepare(
          `INSERT INTO floor_queue_items
             (id, session_id, agent_id, position, status, assigned_by, assigned_reason, intent, origin, source_run_id, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'queued', ?, ?, 'task', ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL AND auto_inject_feedback = 1) AND ${guard}`,
        ).bind(id, context.sessionId, entry.agentId, position, entry.agentId ? "router" : null, entry.agentId ? reason : null,
          entry.nudge.kind, entry.sourceRunId, now, now, context.sessionId, context.candidateId, nextJson),
        database.prepare(
          `INSERT INTO floor_queue_prompts (id, queue_item_id, author_user_id, text, created_at)
           SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM floor_queue_items WHERE id = ?)`,
        ).bind(crypto.randomUUID(), id, context.ownerUserId, entry.nudge.message, now, id),
      );
    }
  }
  statements.push(
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ? AND ended_at IS NULL")
      .bind(now, context.sessionId),
  );
  const results = await database.batch(statements);
  const created = Number(results[0]?.meta?.changes ?? 0) === 1;
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(context.sessionId).first<{ revision: number }>();
  return { revision: Number(revision?.revision ?? 0), created };
}

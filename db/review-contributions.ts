import type {
  AgentRunRollbackScope,
  AgentRunRollbackStatus,
  ReviewContribution,
  ReviewContributionFile,
  ReviewContributionPage,
  ReviewContributionPrompt,
  ReviewContributorFacet,
  ReviewRollbackImpact,
} from "@/lib/floor-types";
import { getDb, type D1DatabaseLike } from "./index";
import { AgentRunConflictError, AgentRunNotReadyError } from "./runs";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type ContributionRow = {
  runId: string;
  queueItemId: string;
  agentId: string;
  agentName: string;
  agentOwnerUserId: string;
  integratedAt: number;
  rollbackStatus: AgentRunRollbackStatus | null;
  rollbackFailureReason: string | null;
  hasRemovedFiles: number;
};

type CandidateContext = {
  id: string;
  candidateSha: string;
  connectionId: string;
};

export type ReviewContributionFilters = {
  status?: "active" | "rolled_back";
  cursor?: string | null;
  limit?: number;
  path?: string | null;
  engineerId?: string | null;
  agentId?: string | null;
};

function diffLines(diff: string): NonNullable<ReviewContributionFile["diff"]> {
  return diff.split("\n").slice(0, 500).map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return { type: "add" as const, text: line.slice(1) };
    if (line.startsWith("-") && !line.startsWith("---")) return { type: "remove" as const, text: line.slice(1) };
    return { type: "context" as const, text: line.startsWith(" ") ? line.slice(1) : line };
  });
}

function parseCursor(cursor: string | null | undefined): { integratedAt: number; runId: string } | null {
  if (!cursor) return null;
  const separator = cursor.indexOf(":");
  const integratedAt = Number(cursor.slice(0, separator));
  const runId = cursor.slice(separator + 1);
  return separator > 0 && Number.isSafeInteger(integratedAt) && integratedAt >= 0 && runId.length > 0
    ? { integratedAt, runId }
    : null;
}

function contributionCursor(item: ReviewContribution): string {
  return `${item.integratedAt}:${item.runId}`;
}

async function activeCandidate(sessionId: string, database: D1DatabaseLike): Promise<CandidateContext | null> {
  return database.prepare(
    `SELECT c.id, c.candidate_sha AS candidateSha, c.connection_id AS connectionId
     FROM repository_candidates c
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE c.session_id = ? AND c.status = 'active' AND c.merged_at IS NULL
       AND c.candidate_sha IS NOT NULL AND rc.status = 'ready'
     ORDER BY c.created_at DESC LIMIT 1`,
  ).bind(sessionId).first<CandidateContext>();
}

async function promptsFor(queueItemId: string, database: D1DatabaseLike): Promise<ReviewContributionPrompt[]> {
  const result = await database.prepare(
    `SELECT p.id, p.author_user_id AS authorUserId, u.display_name AS authorName,
            p.text, p.created_at AS createdAt
     FROM floor_queue_prompts p JOIN users u ON u.id = p.author_user_id
     WHERE p.queue_item_id = ? ORDER BY p.created_at, p.id`,
  ).bind(queueItemId).all<ReviewContributionPrompt>();
  return result.results.map((prompt) => ({ ...prompt, createdAt: Number(prompt.createdAt) }));
}

async function filesFor(runId: string, includeDiff: boolean, database: D1DatabaseLike): Promise<ReviewContributionFile[]> {
  const result = await database.prepare(
    `SELECT id, path, change_kind AS changeKind, additions, deletions, summary, diff_preview AS diffPreview
     FROM agent_run_files WHERE run_id = ? ORDER BY path`,
  ).bind(runId).all<ReviewContributionFile & { diffPreview: string }>();
  return result.results.map(({ diffPreview, ...file }) => ({
    ...file,
    additions: Number(file.additions),
    deletions: Number(file.deletions),
    ...(includeDiff ? { diff: diffLines(diffPreview) } : {}),
  }));
}

async function hydrateContribution(
  row: ContributionRow,
  userId: string,
  owner: boolean,
  includeDiff: boolean,
  database: D1DatabaseLike,
): Promise<ReviewContribution> {
  const [prompts, files] = await Promise.all([
    promptsFor(row.queueItemId, database),
    filesFor(row.runId, includeDiff, database),
  ]);
  const authoredEveryPrompt = prompts.length > 0 && prompts.every((prompt) => prompt.authorUserId === userId);
  return {
    ...row,
    integratedAt: Number(row.integratedAt),
    hasRemovedFiles: Boolean(row.hasRemovedFiles),
    prompts,
    files,
    canRollback: (row.rollbackStatus == null || row.rollbackStatus === "failed") &&
      !Boolean(row.hasRemovedFiles) &&
      (owner || row.agentOwnerUserId === userId || authoredEveryPrompt),
  };
}

function contributionSelect(where: string): string {
  return `SELECT r.id AS runId, r.queue_item_id AS queueItemId, r.agent_id AS agentId,
                 a.name AS agentName, a.owner_user_id AS agentOwnerUserId,
                 r.integrated_at AS integratedAt,
                 latest.status AS rollbackStatus, latest.failure_reason AS rollbackFailureReason,
                 EXISTS (
                   SELECT 1 FROM agent_run_files removed_file
                   JOIN candidate_file_removals removal
                     ON removal.candidate_id = r.candidate_id AND removal.path = removed_file.path
                    AND removal.status = 'completed' AND removal.completed_at >= r.integrated_at
                   WHERE removed_file.run_id = r.id
                 ) AS hasRemovedFiles
          FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id
          LEFT JOIN agent_run_rollbacks latest ON latest.id = (
            SELECT attempt.id FROM agent_run_rollbacks attempt
            WHERE attempt.run_id = r.id ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1
          )
          WHERE ${where}`;
}

async function contributionFacets(candidateId: string, database: D1DatabaseLike): Promise<{
  engineers: ReviewContributorFacet[];
  agents: ReviewContributorFacet[];
}> {
  const activeFileForRun = `EXISTS (
    SELECT 1 FROM agent_run_files active_file WHERE active_file.run_id = r.id
      AND NOT EXISTS (
        SELECT 1 FROM candidate_file_removals removal
        WHERE removal.candidate_id = r.candidate_id AND removal.path = active_file.path
          AND removal.status = 'completed' AND removal.completed_at >= r.integrated_at
      )
  )`;
  const active = `r.candidate_id = ? AND r.status = 'integrated' AND r.kind IS NULL
    AND NOT EXISTS (SELECT 1 FROM agent_run_rollbacks done WHERE done.run_id = r.id AND done.status = 'completed')
    AND ${activeFileForRun}`;
  const activeFileJoin = `f.run_id = r.id AND NOT EXISTS (
    SELECT 1 FROM candidate_file_removals removal
    WHERE removal.candidate_id = r.candidate_id AND removal.path = f.path
      AND removal.status = 'completed' AND removal.completed_at >= r.integrated_at
  )`;
  const [engineers, agents] = await Promise.all([
    database.prepare(
      `SELECT p.author_user_id AS id, u.display_name AS name,
              COUNT(DISTINCT r.id) AS activePromptGroups, COUNT(DISTINCT f.path) AS activeFiles
       FROM agent_runs r JOIN floor_queue_prompts p ON p.queue_item_id = r.queue_item_id
       JOIN users u ON u.id = p.author_user_id LEFT JOIN agent_run_files f ON ${activeFileJoin}
       WHERE ${active} GROUP BY p.author_user_id, u.display_name
       ORDER BY lower(u.display_name), p.author_user_id`,
    ).bind(candidateId).all<ReviewContributorFacet>(),
    database.prepare(
      `SELECT r.agent_id AS id, a.name,
              COUNT(DISTINCT r.id) AS activePromptGroups, COUNT(DISTINCT f.path) AS activeFiles
       FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id
       LEFT JOIN agent_run_files f ON ${activeFileJoin}
       WHERE ${active} GROUP BY r.agent_id, a.name ORDER BY lower(a.name), r.agent_id`,
    ).bind(candidateId).all<ReviewContributorFacet>(),
  ]);
  const normalize = (items: ReviewContributorFacet[]) => items.map((item) => ({
    ...item,
    activePromptGroups: Number(item.activePromptGroups),
    activeFiles: Number(item.activeFiles),
  }));
  return { engineers: normalize(engineers.results), agents: normalize(agents.results) };
}

export async function listReviewContributions(
  sessionId: string,
  userId: string,
  filters: ReviewContributionFilters,
  database = getDb(),
): Promise<ReviewContributionPage | null> {
  const role = await getMembershipRole(sessionId, userId, database);
  if (!role) return null;
  const candidate = await activeCandidate(sessionId, database);
  if (!candidate) return { items: [], nextCursor: null, engineers: [], agents: [] };

  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(filters.limit ?? DEFAULT_PAGE_SIZE)));
  const cursor = parseCursor(filters.cursor);
  if (filters.cursor && !cursor) throw new AgentRunNotReadyError("Invalid contribution cursor");
  const clauses = ["r.candidate_id = ?", "r.status = 'integrated'", "r.kind IS NULL"];
  const values: unknown[] = [candidate.id];
  if ((filters.status ?? "active") === "rolled_back") {
    clauses.push("EXISTS (SELECT 1 FROM agent_run_rollbacks done WHERE done.run_id = r.id AND done.status = 'completed')");
  } else {
    clauses.push("NOT EXISTS (SELECT 1 FROM agent_run_rollbacks done WHERE done.run_id = r.id AND done.status = 'completed')");
    clauses.push(`EXISTS (
      SELECT 1 FROM agent_run_files active_file WHERE active_file.run_id = r.id
        AND NOT EXISTS (
          SELECT 1 FROM candidate_file_removals removal
          WHERE removal.candidate_id = r.candidate_id AND removal.path = active_file.path
            AND removal.status = 'completed' AND removal.completed_at >= r.integrated_at
        )
    )`);
  }
  if (filters.path) {
    clauses.push(`EXISTS (
      SELECT 1 FROM agent_run_files file_filter WHERE file_filter.run_id = r.id AND file_filter.path = ?
        AND NOT EXISTS (
          SELECT 1 FROM candidate_file_removals removal
          WHERE removal.candidate_id = r.candidate_id AND removal.path = file_filter.path
            AND removal.status = 'completed' AND removal.completed_at >= r.integrated_at
        )
    )`);
    values.push(filters.path);
  }
  if (filters.engineerId) {
    clauses.push("EXISTS (SELECT 1 FROM floor_queue_prompts prompt_filter WHERE prompt_filter.queue_item_id = r.queue_item_id AND prompt_filter.author_user_id = ?)");
    values.push(filters.engineerId);
  }
  if (filters.agentId) {
    clauses.push("r.agent_id = ?");
    values.push(filters.agentId);
  }
  if (cursor) {
    clauses.push("(r.integrated_at < ? OR (r.integrated_at = ? AND r.id < ?))");
    values.push(cursor.integratedAt, cursor.integratedAt, cursor.runId);
  }
  values.push(limit + 1);
  const rows = await database.prepare(
    `${contributionSelect(clauses.join(" AND "))} ORDER BY r.integrated_at DESC, r.id DESC LIMIT ?`,
  ).bind(...values).all<ContributionRow>();
  const hasMore = rows.results.length > limit;
  const selected = rows.results.slice(0, limit);
  const [items, facets] = await Promise.all([
    Promise.all(selected.map((row) => hydrateContribution(row, userId, role === "owner", false, database))),
    contributionFacets(candidate.id, database),
  ]);
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? contributionCursor(items[items.length - 1]) : null,
    ...facets,
  };
}

export async function getReviewContribution(
  sessionId: string,
  runId: string,
  userId: string,
  database = getDb(),
): Promise<ReviewContribution | null> {
  const role = await getMembershipRole(sessionId, userId, database);
  if (!role) return null;
  const candidate = await activeCandidate(sessionId, database);
  if (!candidate) return null;
  const row = await database.prepare(
    contributionSelect("r.id = ? AND r.session_id = ? AND r.candidate_id = ? AND r.status = 'integrated' AND r.kind IS NULL"),
  ).bind(runId, sessionId, candidate.id).first<ContributionRow>();
  return row ? hydrateContribution(row, userId, role === "owner", true, database) : null;
}

async function activeContributionRows(candidateId: string, database: D1DatabaseLike): Promise<ContributionRow[]> {
  const result = await database.prepare(
    `${contributionSelect(`r.candidate_id = ? AND r.status = 'integrated' AND r.kind IS NULL
       AND NOT EXISTS (SELECT 1 FROM agent_run_rollbacks done WHERE done.run_id = r.id AND done.status = 'completed')
       AND EXISTS (
         SELECT 1 FROM agent_run_files active_file WHERE active_file.run_id = r.id
           AND NOT EXISTS (
             SELECT 1 FROM candidate_file_removals removal
             WHERE removal.candidate_id = r.candidate_id AND removal.path = active_file.path
               AND removal.status = 'completed' AND removal.completed_at >= r.integrated_at
           )
       )`)}
     ORDER BY r.integrated_at DESC, r.id DESC`,
  ).bind(candidateId).all<ContributionRow>();
  return result.results;
}

export async function resolveReviewRollbackImpact(
  sessionId: string,
  userId: string,
  scope: AgentRunRollbackScope,
  subjectId: string,
  database = getDb(),
): Promise<ReviewRollbackImpact | null> {
  const role = await getActiveMembershipRole(sessionId, userId, database);
  if (!role) return null;
  if (scope !== "prompt" && role !== "owner") return null;
  const candidate = await activeCandidate(sessionId, database);
  if (!candidate) throw new AgentRunConflictError("The candidate is no longer open for rollback");
  const rows = await activeContributionRows(candidate.id, database);
  const matchingRows = scope === "prompt"
    ? rows.filter((row) => row.runId === subjectId)
    : scope === "agent"
      ? rows.filter((row) => row.agentId === subjectId)
      : rows;
  const hydrated = await Promise.all(matchingRows.map((row) => hydrateContribution(row, userId, role === "owner", false, database)));
  const targets: ReviewContribution[] = [];
  const excluded: ReviewRollbackImpact["excluded"] = [];
  if (scope === "engineer") {
    for (const contribution of hydrated) {
      if (!contribution.prompts.some((prompt) => prompt.authorUserId === subjectId)) continue;
      if (contribution.hasRemovedFiles) excluded.push({ ...contribution, exclusionReason: "Contains a file removed separately" });
      else if (contribution.prompts.every((prompt) => prompt.authorUserId === subjectId)) targets.push(contribution);
      else excluded.push({ ...contribution, exclusionReason: "Merged with prompts from another engineer" });
    }
  } else {
    for (const contribution of hydrated) {
      if (contribution.hasRemovedFiles) excluded.push({ ...contribution, exclusionReason: "Contains a file removed separately" });
      else targets.push(contribution);
    }
  }
  if (scope === "prompt" && (!targets[0] || !targets[0].canRollback)) return null;
  if (targets.length === 0) throw new AgentRunConflictError("No active integrated changes match this rollback");
  const subjectName = scope === "prompt"
    ? targets[0].prompts.map((prompt) => prompt.text).join(" + ").slice(0, 120)
    : scope === "agent"
      ? targets[0].agentName
      : targets.flatMap((target) => target.prompts).find((prompt) => prompt.authorUserId === subjectId)?.authorName ?? "Engineer";
  return {
    scope,
    subjectId,
    subjectName,
    expectedCandidateSha: candidate.candidateSha,
    targets,
    excluded,
  };
}

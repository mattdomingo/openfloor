import type {
  FloorAgent,
  FloorAssignment,
  FloorMessage,
  FloorQueueItem,
  FloorQueuePrompt,
  FloorReviewSnapshot,
  FloorSnapshot,
} from "@/lib/floor-types";
import type { AgentInput, AgentTaskInput, AssignmentInput, MessageInput, QueuePromptInput } from "@/lib/validation";
import { getDb, type D1DatabaseLike } from "./index";
import {
  getActiveRepositoryCandidate,
  getLatestRepositoryReviewCandidate,
  getRepositoryCandidateReviewData,
  getRepositoryConnectionForMember,
} from "./repositories";
import { getLatestRepositoryPreflight } from "./preflights";
import { getAgentRuns } from "./runs";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";

type AgentRecord = FloorAgent;
type AssignmentRecord = FloorAssignment;
type MessageRecord = FloorMessage;
type QueueRecord = Omit<FloorQueueItem, "prompts">;
type PromptRecord = FloorQueuePrompt & { queueItemId: string };

export class FloorConflictError extends Error {}
export class FloorTargetError extends Error {}

export async function getFloorSnapshot(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

async function readFloorSnapshot(sessionId: string, userId: string, database: D1DatabaseLike): Promise<FloorSnapshot> {
  const [session, agents, assignments, messages, queue, prompts, repository, activeCandidate, reviewCandidate, latestPreflight, runs] = await Promise.all([
    database.prepare("SELECT floor_revision AS revision, auto_dispatch AS autoDispatch FROM sessions WHERE id = ?").bind(sessionId).first<{ revision: number; autoDispatch: number }>(),
    database.prepare(
      `SELECT a.id, a.name, a.role, a.task, a.owner_user_id AS ownerUserId,
              owner.display_name AS ownerName, a.created_by AS createdByUserId,
              a.state, a.created_at AS createdAt, a.updated_at AS updatedAt
       FROM floor_agents a
       JOIN users owner ON owner.id = a.owner_user_id
       WHERE a.session_id = ?
       ORDER BY a.created_at, a.id`,
    ).bind(sessionId).all<AgentRecord>(),
    database.prepare(
      `SELECT sm.user_id AS userId, u.display_name AS userName, fa.task,
              fa.updated_by AS updatedByUserId, fa.updated_at AS updatedAt
       FROM session_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN floor_assignments fa ON fa.session_id = sm.session_id AND fa.user_id = sm.user_id
       WHERE sm.session_id = ?
       ORDER BY CASE sm.role WHEN 'owner' THEN 0 ELSE 1 END, lower(u.display_name), sm.joined_at`,
    ).bind(sessionId).all<AssignmentRecord>(),
    database.prepare(
      `SELECT m.id, m.author_user_id AS authorUserId, author.display_name AS authorName,
              m.recipient_user_id AS recipientUserId, m.text, m.created_at AS createdAt
       FROM floor_messages m
       JOIN users author ON author.id = m.author_user_id
       WHERE m.session_id = ?
         AND (m.recipient_user_id IS NULL OR m.author_user_id = ? OR m.recipient_user_id = ?)
       ORDER BY m.created_at, m.id`,
    ).bind(sessionId, userId, userId).all<MessageRecord>(),
    database.prepare(
      `SELECT q.id, q.agent_id AS agentId, a.name AS agentName, q.position, q.status,
              q.assigned_by AS assignedBy, q.assigned_reason AS assignedReason,
              q.created_at AS createdAt, q.updated_at AS updatedAt
       FROM floor_queue_items q
       LEFT JOIN floor_agents a ON a.id = q.agent_id
       WHERE q.session_id = ?
       ORDER BY q.position, q.created_at, q.id`,
    ).bind(sessionId).all<QueueRecord>(),
    database.prepare(
      `SELECT p.id, p.queue_item_id AS queueItemId, p.author_user_id AS authorUserId,
              author.display_name AS authorName, p.text, p.created_at AS createdAt
       FROM floor_queue_prompts p
       JOIN floor_queue_items q ON q.id = p.queue_item_id
       JOIN users author ON author.id = p.author_user_id
       WHERE q.session_id = ?
       ORDER BY p.created_at, p.id`,
    ).bind(sessionId).all<PromptRecord>(),
    getRepositoryConnectionForMember(sessionId, userId, database),
    getActiveRepositoryCandidate(sessionId, database),
    getLatestRepositoryReviewCandidate(sessionId, database),
    getLatestRepositoryPreflight(sessionId, database),
    getAgentRuns(sessionId, database),
  ]);

  const promptsByItem = new Map<string, FloorQueuePrompt[]>();
  for (const prompt of prompts.results) {
    const { queueItemId, ...publicPrompt } = prompt;
    const list = promptsByItem.get(queueItemId) ?? [];
    list.push(publicPrompt);
    promptsByItem.set(queueItemId, list);
  }

  const candidateReview = reviewCandidate ? await getRepositoryCandidateReviewData(reviewCandidate.id, database) : null;
  return {
    revision: Number(session?.revision ?? 0),
    autoDispatch: Boolean(session?.autoDispatch),
    agents: agents.results,
    assignments: assignments.results.map((assignment) => ({
      ...assignment,
      task: assignment.task ?? null,
      updatedByUserId: assignment.updatedByUserId ?? null,
      updatedAt: assignment.updatedAt ?? null,
    })),
    messages: messages.results.map((message) => ({ ...message, recipientUserId: message.recipientUserId ?? null })),
    queue: queue.results.map((item) => ({ ...item, position: Number(item.position), prompts: promptsByItem.get(item.id) ?? [] })),
    repository,
    activeCandidate,
    latestPreflight,
    runs,
    review: buildRunReview(runs, reviewCandidate, candidateReview),
  };
}

function buildRunReview(
  runs: Awaited<ReturnType<typeof getAgentRuns>>,
  candidate: Awaited<ReturnType<typeof getLatestRepositoryReviewCandidate>>,
  githubReview: Awaited<ReturnType<typeof getRepositoryCandidateReviewData>> | null,
): FloorReviewSnapshot | null {
  if (!candidate) return null;
  const candidateRuns = runs.filter((item) => item.candidateId === candidate.id && item.files.length > 0);
  if (candidateRuns.length === 0 && !candidate.pullRequestNumber) return null;
  const reviewRuns = candidate.pullRequestNumber ? candidateRuns.filter((run) => run.status === "integrated") : candidateRuns;
  const files = githubReview?.files.length ? githubReview.files.map((file) => ({
    id: file.id,
    path: file.path,
    agentId: null,
    agentName: null,
    additions: Number(file.additions),
    deletions: Number(file.deletions),
    summary: "GitHub pull request diff",
    diff: diffLines(file.patchPreview),
  })) : [...new Map([...reviewRuns].reverse().flatMap((run) => run.files.map((file) => [file.path, { run, file }] as const))).values()].map(({ run, file }) => ({
    id: file.id,
    path: file.path,
    agentId: run.agentId,
    agentName: run.agentName,
    additions: file.additions,
    deletions: file.deletions,
    summary: file.summary,
    diff: diffLines(file.diffPreview),
  }));
  const localChecks = reviewRuns.flatMap((run) => run.checks.map((check) => ({
    id: `${run.id}:${check.id}`,
    name: check.command,
    detail: `${run.agentName} · ${check.outputExcerpt ?? run.status}`,
    state: check.status === "passed" ? "passed" as const : check.status === "failed" || check.status === "timed_out" ? "failed" as const : "waiting" as const,
  })));
  const checks = [...(githubReview?.checks.map((check) => ({ id: check.id, name: check.name, detail: check.detail, state: check.state })) ?? []), ...localChecks];
  const conflicted = candidateRuns.find((run) => run.status === "conflicted");
  const warnings: FloorReviewSnapshot["warnings"] = [];
  if (conflicted) warnings.push({ id: `${conflicted.id}-conflict`, title: "Integration conflict", detail: conflicted.conflictReason ?? "A run conflicts with the candidate.", severity: "conflict" });
  if (candidate.behindBase && candidate.status === "active") warnings.push({ id: `${candidate.id}-behind`, title: "Base branch advanced", detail: "Synchronize and resolve the candidate before merging.", severity: "warning" });
  if (candidate.githubChecksPassing === false) warnings.push({ id: `${candidate.id}-checks`, title: "GitHub checks are not passing", detail: "All reported GitHub checks must pass before squash merge.", severity: "warning" });
  if (candidate.cleanupStatus === "partial") warnings.push({ id: `${candidate.id}-cleanup`, title: "Branch cleanup incomplete", detail: "At least one OpenFloor branch changed externally and was preserved.", severity: "warning" });
  return {
    id: candidate.id,
    status: candidate.status === "merged" ? "merged" : candidate.pullRequestDraft === false ? "ready" : "draft",
    branch: candidate.branchName,
    baseBranch: candidate.baseBranch,
    commitSha: candidate.status === "merged" ? candidate.mergeCommitSha : candidate.candidateSha,
    files,
    checks,
    warnings,
    updatedAt: Math.max(candidate.updatedAt, ...candidateRuns.map((run) => run.updatedAt), 0),
    githubChecksPassing: candidate.githubChecksPassing,
    cleanupStatus: candidate.cleanupStatus,
    pullRequest: candidate.pullRequestNumber && candidate.pullRequestUrl && candidate.pullRequestState ? {
      number: candidate.pullRequestNumber,
      url: candidate.pullRequestUrl,
      state: candidate.pullRequestState,
      draft: candidate.pullRequestDraft ?? true,
      merged: candidate.pullRequestMerged ?? false,
      mergeable: candidate.pullRequestMergeable,
      mergeableState: candidate.pullRequestMergeableState,
    } : null,
  };
}

function diffLines(diff: string): FloorReviewSnapshot["files"][number]["diff"] {
  return diff.split("\n").slice(0, 500).map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return { type: "add" as const, text: line.slice(1) };
    if (line.startsWith("-") && !line.startsWith("---")) return { type: "remove" as const, text: line.slice(1) };
    return { type: "context" as const, text: line.startsWith(" ") ? line.slice(1) : line };
  });
}

export async function createFloorAgent(
  sessionId: string,
  userId: string,
  input: AgentInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  if (!(await isSessionMember(sessionId, input.ownerUserId, database))) throw new FloorTargetError("Agent owner must be a session member.");
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    const results = await database.batch([
      database.prepare(
        `INSERT INTO floor_agents
           (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
      ).bind(id, sessionId, userId, input.ownerUserId, input.name, input.nameKey, input.role, input.task, now, now, sessionId),
      bumpFloorRevision(database, sessionId, now),
    ]);
    if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new FloorConflictError("An agent with that name already exists.");
    throw error;
  }
  return readFloorSnapshot(sessionId, userId, database);
}

export async function updateFloorAgentTask(
  sessionId: string,
  userId: string,
  agentId: string,
  input: AgentTaskInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `UPDATE floor_agents SET task = ?, updated_at = ?
       WHERE id = ? AND session_id = ?
         AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(input.task, now, agentId, sessionId, sessionId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

export async function updateFloorAssignment(
  sessionId: string,
  userId: string,
  memberId: string,
  input: AssignmentInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  if (!(await isSessionMember(sessionId, memberId, database))) throw new FloorTargetError("Assignment owner must be a session member.");
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `INSERT INTO floor_assignments (session_id, user_id, task, updated_by, updated_at)
       SELECT ?, ?, ?, ?, ? FROM sessions WHERE id = ? AND ended_at IS NULL
       ON CONFLICT(session_id, user_id) DO UPDATE SET
         task = excluded.task, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(sessionId, memberId, input.task, userId, now, sessionId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

export async function createFloorMessage(
  sessionId: string,
  userId: string,
  input: MessageInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  if (input.recipientUserId && !(await isSessionMember(sessionId, input.recipientUserId, database))) {
    throw new FloorTargetError("Message recipient must be a session member.");
  }
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `INSERT INTO floor_messages (id, session_id, author_user_id, recipient_user_id, text, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(crypto.randomUUID(), sessionId, userId, input.recipientUserId, input.text, now, sessionId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

export async function createFloorQueueItem(
  sessionId: string,
  userId: string,
  input: QueuePromptInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  if (input.agentId && !(await isSessionAgent(sessionId, input.agentId, database))) {
    throw new FloorTargetError("Queue target must belong to this session.");
  }
  const last = await database.prepare(
    "SELECT COALESCE(MAX(position), 0) AS position FROM floor_queue_items WHERE session_id = ?",
  ).bind(sessionId).first<{ position: number }>();
  const itemId = crypto.randomUUID();
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, assigned_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'queued', ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(itemId, sessionId, input.agentId, Number(last?.position ?? 0) + 1, input.agentId ? "user" : null, now, now, sessionId),
    database.prepare(
      `INSERT INTO floor_queue_prompts (id, queue_item_id, author_user_id, text, created_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM floor_queue_items WHERE id = ?)`,
    ).bind(crypto.randomUUID(), itemId, userId, input.prompt, now, itemId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

export async function reorderFloorQueue(
  sessionId: string,
  userId: string,
  itemIds: string[],
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  const current = await queueIds(sessionId, database);
  if (!sameIds(current, itemIds)) throw new FloorConflictError("Queue order is stale. Refresh and try again.");
  const now = Date.now();
  const results = await database.batch([
    ...itemIds.map((id, index) => database.prepare(
      `UPDATE floor_queue_items SET position = ?, updated_at = ? WHERE id = ? AND session_id = ?
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(index + 1, now, id, sessionId, sessionId)),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

export async function mergeFloorQueue(
  sessionId: string,
  userId: string,
  itemIds: string[],
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  const selected = await database.prepare(
    `SELECT id, agent_id AS agentId, position, status FROM floor_queue_items
     WHERE session_id = ? AND id IN (${itemIds.map(() => "?").join(", ")})
     ORDER BY position, created_at, id`,
  ).bind(sessionId, ...itemIds).all<{ id: string; agentId: string | null; position: number; status: string }>();
  if (selected.results.length !== itemIds.length) throw new FloorConflictError("One or more queue items no longer exist.");
  if (selected.results.some((item) => item.status !== "queued")) throw new FloorConflictError("Only queued items can be merged.");
  const target = selected.results[0]?.agentId ?? null;
  if (selected.results.some((item) => (item.agentId ?? null) !== target)) {
    throw new FloorTargetError("Only queue items with the same target can be merged.");
  }
  const survivor = selected.results[0].id;
  const removed = new Set(selected.results.slice(1).map((item) => item.id));
  const allIds = await queueIds(sessionId, database);
  const remaining = allIds.filter((id) => !removed.has(id));
  const now = Date.now();
  const results = await database.batch([
    ...selected.results.slice(1).map((item) => database.prepare(
      `UPDATE floor_queue_prompts SET queue_item_id = ? WHERE queue_item_id = ?
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(survivor, item.id, sessionId)),
    ...selected.results.slice(1).map((item) => database.prepare(
      `DELETE FROM floor_queue_items WHERE id = ? AND session_id = ?
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(item.id, sessionId, sessionId)),
    ...remaining.map((id, index) => database.prepare(
      `UPDATE floor_queue_items SET position = ?, updated_at = ? WHERE id = ? AND session_id = ?
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(index + 1, now, id, sessionId, sessionId)),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

function bumpFloorRevision(database: D1DatabaseLike, sessionId: string, now: number) {
  return database.prepare(
    "UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ? AND ended_at IS NULL",
  ).bind(now, sessionId);
}

async function activeBatchApplied(results: Array<{ meta?: { changes?: number } }>, sessionId: string, userId: string, database: D1DatabaseLike) {
  if (Number(results.at(-1)?.meta?.changes ?? 0) === 1) return true;
  return Boolean(await getActiveMembershipRole(sessionId, userId, database));
}

async function isSessionMember(sessionId: string, userId: string, database: D1DatabaseLike) {
  const row = await database.prepare(
    "SELECT 1 AS present FROM session_members WHERE session_id = ? AND user_id = ?",
  ).bind(sessionId, userId).first<{ present: number }>();
  return Boolean(row);
}

async function isSessionAgent(sessionId: string, agentId: string, database: D1DatabaseLike) {
  const row = await database.prepare(
    "SELECT 1 AS present FROM floor_agents WHERE session_id = ? AND id = ?",
  ).bind(sessionId, agentId).first<{ present: number }>();
  return Boolean(row);
}

async function queueIds(sessionId: string, database: D1DatabaseLike) {
  const result = await database.prepare(
    "SELECT id FROM floor_queue_items WHERE session_id = ? ORDER BY position, created_at, id",
  ).bind(sessionId).all<{ id: string }>();
  return result.results.map((row) => row.id);
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

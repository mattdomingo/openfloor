import type {
  FloorAgent,
  FloorAssignment,
  FloorMessage,
  FloorQueueItem,
  FloorQueuePrompt,
  FloorReviewSnapshot,
  FloorSnapshot,
} from "@/lib/floor-types";
import type { AgentInput, AssignmentInput, MessageInput, QueuePromptInput } from "@/lib/validation";
import { getDb, type D1DatabaseLike } from "./index";
import { getActiveRepositoryCandidate, getRepositoryConnectionForMember } from "./repositories";
import { getLatestRepositoryPreflight } from "./preflights";
import { getAgentRuns } from "./runs";
import { getMembershipRole } from "./sessions";

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
  const [session, agents, assignments, messages, queue, prompts, repository, activeCandidate, latestPreflight, runs] = await Promise.all([
    database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(sessionId).first<{ revision: number }>(),
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

  return {
    revision: Number(session?.revision ?? 0),
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
    review: buildRunReview(runs, activeCandidate?.branchName ?? null, activeCandidate?.baseBranch ?? null),
  };
}

function buildRunReview(runs: Awaited<ReturnType<typeof getAgentRuns>>, branch: string | null, baseBranch: string | null): FloorReviewSnapshot | null {
  const run = runs.find((item) => item.files.length > 0);
  if (!run || !branch || !baseBranch) return null;
  return {
    id: run.id,
    status: "awaiting",
    branch: run.runBranch ?? branch,
    baseBranch,
    commitSha: run.runCommitSha,
    files: run.files.map((file) => ({
      id: file.id,
      path: file.path,
      agentId: run.agentId,
      agentName: run.agentName,
      additions: file.additions,
      deletions: file.deletions,
      summary: file.summary,
      diff: diffLines(file.diffPreview),
    })),
    checks: run.checks.map((check) => ({
      id: check.id,
      name: check.command,
      detail: check.outputExcerpt,
      state: check.status === "passed" ? "passed" : check.status === "failed" || check.status === "timed_out" ? "failed" : "waiting",
    })),
    warnings: run.status === "published" && !run.discardedAt ? [] : [{
      id: `${run.id}-status`,
      title: run.discardedAt ? "Run branch discarded" : "Run is not published",
      detail: run.discardedAt ? "The verified run branch was safely deleted from GitHub; its audit history remains in OpenFloor." : run.summary ?? `The run is currently ${run.status.replace("_", " ")}.`,
      severity: "warning",
    }],
    updatedAt: run.updatedAt,
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
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  if (!(await isSessionMember(sessionId, input.ownerUserId, database))) throw new FloorTargetError("Agent owner must be a session member.");
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO floor_agents
           (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
      ).bind(id, sessionId, userId, input.ownerUserId, input.name, input.nameKey, input.role, input.task, now, now),
      bumpFloorRevision(database, sessionId, now),
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new FloorConflictError("An agent with that name already exists.");
    throw error;
  }
  return readFloorSnapshot(sessionId, userId, database);
}

export async function updateFloorAssignment(
  sessionId: string,
  userId: string,
  memberId: string,
  input: AssignmentInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  if (!(await isSessionMember(sessionId, memberId, database))) throw new FloorTargetError("Assignment owner must be a session member.");
  const now = Date.now();
  await database.batch([
    database.prepare(
      `INSERT INTO floor_assignments (session_id, user_id, task, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, user_id) DO UPDATE SET
         task = excluded.task, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(sessionId, memberId, input.task, userId, now),
    bumpFloorRevision(database, sessionId, now),
  ]);
  return readFloorSnapshot(sessionId, userId, database);
}

export async function createFloorMessage(
  sessionId: string,
  userId: string,
  input: MessageInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  if (input.recipientUserId && !(await isSessionMember(sessionId, input.recipientUserId, database))) {
    throw new FloorTargetError("Message recipient must be a session member.");
  }
  const now = Date.now();
  await database.batch([
    database.prepare(
      "INSERT INTO floor_messages (id, session_id, author_user_id, recipient_user_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), sessionId, userId, input.recipientUserId, input.text, now),
    bumpFloorRevision(database, sessionId, now),
  ]);
  return readFloorSnapshot(sessionId, userId, database);
}

export async function createFloorQueueItem(
  sessionId: string,
  userId: string,
  input: QueuePromptInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  if (input.agentId && !(await isSessionAgent(sessionId, input.agentId, database))) {
    throw new FloorTargetError("Queue target must belong to this session.");
  }
  const last = await database.prepare(
    "SELECT COALESCE(MAX(position), 0) AS position FROM floor_queue_items WHERE session_id = ?",
  ).bind(sessionId).first<{ position: number }>();
  const itemId = crypto.randomUUID();
  const now = Date.now();
  await database.batch([
    database.prepare(
      `INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(itemId, sessionId, input.agentId, Number(last?.position ?? 0) + 1, now, now),
    database.prepare(
      "INSERT INTO floor_queue_prompts (id, queue_item_id, author_user_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), itemId, userId, input.prompt, now),
    bumpFloorRevision(database, sessionId, now),
  ]);
  return readFloorSnapshot(sessionId, userId, database);
}

export async function reorderFloorQueue(
  sessionId: string,
  userId: string,
  itemIds: string[],
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const current = await queueIds(sessionId, database);
  if (!sameIds(current, itemIds)) throw new FloorConflictError("Queue order is stale. Refresh and try again.");
  const now = Date.now();
  await database.batch([
    ...itemIds.map((id, index) => database.prepare(
      "UPDATE floor_queue_items SET position = ?, updated_at = ? WHERE id = ? AND session_id = ?",
    ).bind(index + 1, now, id, sessionId)),
    bumpFloorRevision(database, sessionId, now),
  ]);
  return readFloorSnapshot(sessionId, userId, database);
}

export async function mergeFloorQueue(
  sessionId: string,
  userId: string,
  itemIds: string[],
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
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
  await database.batch([
    ...selected.results.slice(1).map((item) => database.prepare(
      "UPDATE floor_queue_prompts SET queue_item_id = ? WHERE queue_item_id = ?",
    ).bind(survivor, item.id)),
    ...selected.results.slice(1).map((item) => database.prepare(
      "DELETE FROM floor_queue_items WHERE id = ? AND session_id = ?",
    ).bind(item.id, sessionId)),
    ...remaining.map((id, index) => database.prepare(
      "UPDATE floor_queue_items SET position = ?, updated_at = ? WHERE id = ? AND session_id = ?",
    ).bind(index + 1, now, id, sessionId)),
    bumpFloorRevision(database, sessionId, now),
  ]);
  return readFloorSnapshot(sessionId, userId, database);
}

function bumpFloorRevision(database: D1DatabaseLike, sessionId: string, now: number) {
  return database.prepare(
    "UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?",
  ).bind(now, sessionId);
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

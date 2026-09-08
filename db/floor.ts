import { readGitHubIdentity } from "@/lib/github-identity";
import type {
  AgentRun,
  FloorAgent,
  FloorAssignment,
  FloorMessage,
  FloorQueueItem,
  FloorQueuePrompt,
  FloorReviewSnapshot,
  FloorSnapshot,
  ReviewContributor,
  SessionFile,
} from "@/lib/floor-types";
import type { AgentInput, AgentSettingsInput, AssignmentInput, MessageInput, QueuePromptInput } from "@/lib/validation";
import { normalizeAgentName } from "@/lib/validation";
import { credentialKindsForProvider, PROVIDER_MODELS, type CredentialProvider } from "@/lib/provider-credentials";
import { getDb, type D1DatabaseLike } from "./index";
import {
  getActiveRepositoryCandidate,
  getLatestRepositoryReviewCandidate,
  getRepositoryCandidateReviewData,
  getRepositoryConnectionForMember,
} from "./repositories";
import { getLatestRepositoryPreflight } from "./preflights";
import { getAgentRuns, getAgentRunsForCandidate, requestAgentRunCancellation } from "./runs";
import { getMergeConflictCases } from "./conflicts";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";
import { resolveAutoAgentProvider } from "./provider-credentials";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { env } from "cloudflare:workers";
import { getRepositoryPreview } from "./previews";

type AgentRecord = FloorAgent;
type AssignmentRecord = FloorAssignment;
type MessageRecord = FloorMessage;
type QueueRecord = Omit<FloorQueueItem, "prompts" | "rollback" | "answer"> & {
  rollbackRunId: string | null;
  rollbackStatus: AgentRun["rollbackStatus"];
  rollbackFailureReason: string | null;
  agentOwnerUserId: string | null;
  answerRunId: string | null;
  answerAgentId: string | null;
  answerAgentName: string | null;
  answerText: string | null;
  answerCreatedAt: number | null;
};
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
  const [session, providerResolution, agents, assignments, messages, files, queue, prompts, repository, activeCandidate, reviewCandidate, latestPreflight, preview, runs, conflicts] = await Promise.all([
    database.prepare(
      `SELECT s.floor_revision AS revision, s.auto_dispatch AS autoDispatch,
              s.auto_provision_agents AS autoProvisionAgents, s.auto_resolve_conflicts AS autoResolveConflicts,
              s.auto_inject_feedback AS autoInjectFeedback,
              (SELECT role FROM session_members WHERE session_id = s.id AND user_id = ? AND removed_at IS NULL) AS viewerRole
       FROM sessions s WHERE s.id = ?`,
    ).bind(userId, sessionId).first<{ revision: number; autoDispatch: number; autoProvisionAgents: number; autoResolveConflicts: number; autoInjectFeedback: number; viewerRole: "owner" | "member" }>(),
    resolveAutoAgentProvider(sessionId, database, disabledRunProviders()),
    database.prepare(
      // Two extra joins for lifetime cost (Agent tile meter): `cost` sums
      // every priced run and flags a mixed reported/estimated history (an
      // agent whose model crossed the anthropic/kimi/glm boundary mid-life —
      // see lib/run-usage.ts); `latest_run` finds the most recent run whose
      // billed_kind is known, so "incl. in subscription" reflects who pays
      // NOW, not an average across the agent's history. Both LEFT JOIN so an
      // agent with no priced runs yet still returns a row (null cost, not a
      // dropped agent). idx_agent_runs_agent_created covers both.
      `SELECT a.id, a.name, a.role, a.task, a.owner_user_id AS ownerUserId,
              owner.display_name AS ownerName, a.created_by AS createdByUserId,
              a.state, a.kind, a.provider, a.model,
              a.credential_kind AS credentialKind, a.paused_at AS pausedAt,
              a.created_at AS createdAt, a.updated_at AS updatedAt,
              cost.costMicroUsd AS costMicroUsd, cost.costSource AS costSource,
              latest_run.billed_kind AS billedKind
       FROM floor_agents a
       JOIN users owner ON owner.id = a.owner_user_id
       LEFT JOIN (
         SELECT agent_id, SUM(cost_micro_usd) AS costMicroUsd,
                CASE WHEN COUNT(DISTINCT cost_source) > 1 THEN 'mixed' ELSE MIN(cost_source) END AS costSource
         FROM agent_runs WHERE cost_micro_usd IS NOT NULL GROUP BY agent_id
       ) cost ON cost.agent_id = a.id
       LEFT JOIN agent_runs latest_run ON latest_run.id = (
         SELECT r2.id FROM agent_runs r2 WHERE r2.agent_id = a.id AND r2.billed_kind IS NOT NULL
         ORDER BY r2.created_at DESC LIMIT 1
       )
       WHERE a.session_id = ? AND a.deprovisioned_at IS NULL
       ORDER BY a.created_at, a.id`,
    ).bind(sessionId).all<AgentRecord>(),
    database.prepare(
      `SELECT sm.user_id AS userId, u.display_name AS userName, fa.task,
              fa.updated_by AS updatedByUserId, fa.updated_at AS updatedAt
       FROM session_members sm
       JOIN users u ON u.id = sm.user_id
       LEFT JOIN floor_assignments fa ON fa.session_id = sm.session_id AND fa.user_id = sm.user_id
       WHERE sm.session_id = ? AND sm.removed_at IS NULL
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
      `SELECT f.id, f.uploaded_by_user_id AS uploadedByUserId, uploader.display_name AS uploadedByName,
              f.message_id AS messageId, f.name, f.content_type AS contentType,
              f.size_bytes AS sizeBytes, f.created_at AS createdAt
       FROM session_files f JOIN users uploader ON uploader.id = f.uploaded_by_user_id
       WHERE f.session_id = ? ORDER BY f.created_at, f.id`,
    ).bind(sessionId).all<SessionFile>(),
    database.prepare(
      `SELECT q.id, q.agent_id AS agentId, a.name AS agentName, a.owner_user_id AS agentOwnerUserId,
              q.position, q.status,
              q.assigned_by AS assignedBy, q.assigned_reason AS assignedReason, q.intent, q.origin,
              q.created_at AS createdAt, q.updated_at AS updatedAt,
              rollback_run.id AS rollbackRunId, latest_rollback.status AS rollbackStatus,
              latest_rollback.failure_reason AS rollbackFailureReason,
              reply_run.id AS answerRunId, reply_run.agent_id AS answerAgentId,
              reply_agent.name AS answerAgentName, reply_run.final_response AS answerText,
              reply_run.completed_at AS answerCreatedAt
       FROM floor_queue_items q
       LEFT JOIN floor_agents a ON a.id = q.agent_id
       LEFT JOIN agent_runs rollback_run ON rollback_run.id = (
         SELECT candidate.id FROM agent_runs candidate
         WHERE candidate.queue_item_id = q.id AND candidate.status = 'integrated' AND candidate.kind IS NULL
         ORDER BY candidate.integrated_at DESC, candidate.id DESC LIMIT 1
       )
       LEFT JOIN agent_run_rollbacks latest_rollback ON latest_rollback.id = (
         SELECT attempt.id FROM agent_run_rollbacks attempt
         WHERE attempt.run_id = rollback_run.id ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1
       )
       LEFT JOIN agent_runs reply_run ON reply_run.id = (
         SELECT candidate.id FROM agent_runs candidate
         WHERE candidate.queue_item_id = q.id AND candidate.kind = 'reply' AND candidate.final_response IS NOT NULL
         ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
       )
       LEFT JOIN floor_agents reply_agent ON reply_agent.id = reply_run.agent_id
       WHERE q.session_id = ? AND q.dismissed_at IS NULL
       ORDER BY q.position, q.created_at, q.id`,
    ).bind(sessionId).all<QueueRecord>(),
    database.prepare(
      `SELECT p.id, p.queue_item_id AS queueItemId, p.author_user_id AS authorUserId,
              author.verified_github AS githubIdentity, author.display_name AS authorName, p.text, p.created_at AS createdAt
       FROM floor_queue_prompts p
       JOIN floor_queue_items q ON q.id = p.queue_item_id
       JOIN users author ON author.id = p.author_user_id
       WHERE q.session_id = ? AND q.dismissed_at IS NULL
       ORDER BY p.created_at, p.id`,
    ).bind(sessionId).all<PromptRecord & { githubIdentity: string | null }>(),
    getRepositoryConnectionForMember(sessionId, userId, database),
    getActiveRepositoryCandidate(sessionId, database),
    getLatestRepositoryReviewCandidate(sessionId, database),
    getLatestRepositoryPreflight(sessionId, database),
    (env as unknown as { REPOSITORY_PREVIEW_ENABLED?: string }).REPOSITORY_PREVIEW_ENABLED === "true"
      ? getRepositoryPreview(sessionId, database)
      : Promise.resolve(null),
    getAgentRuns(sessionId, database),
    getMergeConflictCases(sessionId, database),
  ]);

  const promptsByItem = new Map<string, FloorQueuePrompt[]>();
  for (const prompt of prompts.results) {
    const { queueItemId, githubIdentity, ...publicPrompt } = prompt;
    const list = promptsByItem.get(queueItemId) ?? [];
    list.push({ ...publicPrompt, githubVerified: Boolean(readGitHubIdentity(githubIdentity)) });
    promptsByItem.set(queueItemId, list);
  }

  const candidateReview = reviewCandidate ? await getRepositoryCandidateReviewData(reviewCandidate.id, database) : null;
  const candidateRuns = reviewCandidate ? await getAgentRunsForCandidate(reviewCandidate.id, database) : runs;
  return {
    revision: Number(session?.revision ?? 0),
    autoDispatch: Boolean(session?.autoDispatch),
    autoProvisionAgents: Boolean(session?.autoProvisionAgents),
    autoAgentProvider: providerResolution.configuredProvider,
    effectiveAutoAgentProvider: providerResolution.effectiveProvider,
    autoAgentProviderState: providerResolution.state,
    autoResolveConflicts: Boolean(session?.autoResolveConflicts),
    autoInjectFeedback: Boolean(session?.autoInjectFeedback),
    agents: agents.results,
    assignments: assignments.results.map((assignment) => ({
      ...assignment,
      task: assignment.task ?? null,
      updatedByUserId: assignment.updatedByUserId ?? null,
      updatedAt: assignment.updatedAt ?? null,
    })),
    messages: messages.results.map((message) => ({ ...message, recipientUserId: message.recipientUserId ?? null })),
    files: files.results.map((file) => ({ ...file, messageId: file.messageId ?? null })),
    queue: queue.results.map((item) => {
      const prompts = promptsByItem.get(item.id) ?? [];
      const { rollbackRunId, rollbackStatus, rollbackFailureReason, agentOwnerUserId, answerRunId, answerAgentId, answerAgentName, answerText, answerCreatedAt, ...queueItem } = item;
      const authoredEveryPrompt = prompts.length > 0 && prompts.every((prompt) => prompt.authorUserId === userId);
      return {
        ...queueItem,
        position: Number(item.position),
        prompts,
        rollback: rollbackRunId ? {
          runId: rollbackRunId,
          status: rollbackStatus ?? null,
          failureReason: rollbackFailureReason ?? null,
          canStart: (rollbackStatus == null || rollbackStatus === "failed") &&
            (session?.viewerRole === "owner" || agentOwnerUserId === userId || authoredEveryPrompt),
        } : null,
        // Durable answer surface for a question/noise item: sourced from the
        // queue item's own most recent reply run rather than the runs[]
        // array PromptQueue also receives, so it survives both the
        // Concierge retiring (reply_agent carries no deprovisioned_at
        // filter) and getAgentRuns' 20-row window.
        answer: answerRunId && answerText ? {
          runId: answerRunId,
          agentId: answerAgentId,
          agentName: answerAgentName ?? "Agent",
          text: answerText,
          createdAt: answerCreatedAt ?? item.updatedAt,
        } : null,
      };
    }),
    repository,
    activeCandidate,
    latestPreflight,
    preview,
    runs,
    review: buildRunReview(candidateRuns, reviewCandidate, candidateReview, promptsByItem, assignments.results, conflicts),
  };
}

/** Newest-run-first list of who touched each file: which agent, and which engineer(s) asked for it. */
function contributorsByPath(
  reviewRuns: AgentRun[],
  promptsByItem: Map<string, FloorQueuePrompt[]>,
  memberNames: Map<string, string>,
): Map<string, ReviewContributor[]> {
  const byPath = new Map<string, ReviewContributor[]>();
  for (const run of reviewRuns) {
    const prompts = promptsByItem.get(run.queueItemId) ?? [];
    const requestedBy = prompts.length > 0
      ? [...new Map(prompts.map((prompt) => [prompt.authorUserId, { userId: prompt.authorUserId, userName: prompt.authorName }])).values()]
      : [{ userId: run.createdBy, userName: memberNames.get(run.createdBy) ?? "Unknown" }];
    for (const file of run.files) {
      const contributors = byPath.get(file.path) ?? [];
      const existing = contributors.find((contributor) => contributor.agentId === run.agentId);
      if (existing) {
        for (const requester of requestedBy) {
          if (!existing.requestedBy.some((current) => current.userId === requester.userId)) existing.requestedBy.push(requester);
        }
      } else {
        contributors.push({ agentId: run.agentId, agentName: run.agentName, requestedBy });
      }
      byPath.set(file.path, contributors);
    }
  }
  return byPath;
}

function buildRunReview(
  runs: Awaited<ReturnType<typeof getAgentRuns>>,
  candidate: Awaited<ReturnType<typeof getLatestRepositoryReviewCandidate>>,
  githubReview: Awaited<ReturnType<typeof getRepositoryCandidateReviewData>> | null,
  promptsByItem: Map<string, FloorQueuePrompt[]>,
  members: Array<{ userId: string; userName: string }>,
  conflicts: Awaited<ReturnType<typeof getMergeConflictCases>>,
): FloorReviewSnapshot | null {
  if (!candidate) return null;
  const candidateRuns = runs.filter((item) => item.candidateId === candidate.id && item.files.length > 0);
  if (candidateRuns.length === 0 && !candidate.pullRequestNumber) return null;
  const reviewRuns = (candidate.pullRequestNumber ? candidateRuns.filter((run) => run.status === "integrated") : candidateRuns)
    .filter((run) => run.rollbackStatus !== "completed");
  const memberNames = new Map(members.map((member) => [member.userId, member.userName]));
  const contributors = contributorsByPath(reviewRuns, promptsByItem, memberNames);
  const files = githubReview?.files.length ? githubReview.files.map((file) => ({
    id: file.id,
    path: file.path,
    contributors: contributors.get(file.path) ?? [],
    additions: Number(file.additions),
    deletions: Number(file.deletions),
    summary: "GitHub pull request diff",
    diff: diffLines(file.patchPreview),
  })) : [...new Map([...reviewRuns].reverse().flatMap((run) => run.files.map((file) => [file.path, file] as const))).values()].map((file) => ({
    id: file.id,
    path: file.path,
    contributors: contributors.get(file.path) ?? [],
    additions: file.additions,
    deletions: file.deletions,
    summary: file.summary,
    diff: diffLines(file.diffPreview),
  }));
  const checks = githubReview?.checks.map((check) => ({ id: check.id, name: check.name, detail: check.detail, state: check.state })) ?? [];
  const activeConflictSourceIds = new Set(conflicts.filter((item) => !["resolved", "cancelled"].includes(item.status)).map((item) => item.latestSourceRunId));
  const conflicted = candidateRuns.find((run) => run.status === "conflicted" && activeConflictSourceIds.has(run.id));
  const warnings: FloorReviewSnapshot["warnings"] = [];
  if (conflicted) warnings.push({ id: `${conflicted.id}-conflict`, title: "Integration conflict", detail: conflicted.conflictReason ?? "A run conflicts with the candidate.", severity: "conflict" });
  if (candidate.behindBase && candidate.status === "active") warnings.push({ id: `${candidate.id}-behind`, title: "Base branch advanced", detail: "Synchronize and resolve the candidate before merging.", severity: "warning" });
  if (candidate.githubChecksPassing === false) warnings.push({ id: `${candidate.id}-checks`, title: "GitHub checks are not passing", detail: "All reported GitHub checks must pass before squash merge.", severity: "warning" });
  if (candidate.cleanupStatus === "partial") warnings.push({ id: `${candidate.id}-cleanup`, title: "Branch cleanup incomplete", detail: "At least one openfloor branch changed externally and was preserved.", severity: "warning" });
  if (candidate.integrationRunId) warnings.push({ id: `${candidate.id}-integrating`, title: "Candidate update in progress", detail: "A run is integrating or being rolled back. Merging, ending, and deleting are blocked until the candidate update finishes.", severity: "warning" });
  return {
    id: candidate.id,
    status: candidate.status === "merged" ? "merged" : candidate.status === "abandoned" ? "abandoned" : candidate.pullRequestDraft === false ? "ready" : "draft",
    branch: candidate.branchName,
    baseBranch: candidate.baseBranch,
    commitSha: candidate.status === "merged" ? candidate.mergeCommitSha : candidate.candidateSha,
    files,
    checks,
    warnings,
    conflicts,
    updatedAt: Math.max(candidate.updatedAt, ...candidateRuns.map((run) => run.updatedAt), ...conflicts.map((conflict) => conflict.updatedAt), 0),
    githubChecksPassing: candidate.githubChecksPassing,
    mergeLockedAt: candidate.mergeLockedAt,
    cleanupStatus: candidate.cleanupStatus,
    branchDeletedAt: candidate.branchDeletedAt,
    integrationRunId: candidate.integrationRunId,
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
  if (input.ownerUserId && input.ownerUserId !== userId) throw new FloorTargetError("Agents can only be owned by the member who creates them.");
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    const results = await database.batch([
      database.prepare(
        `INSERT INTO floor_agents
           (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, provider, credential_kind, model, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
      ).bind(id, sessionId, userId, userId, input.name, input.nameKey, input.role, input.task, input.provider, input.credentialKind, input.model, now, now, sessionId),
      bumpFloorRevision(database, sessionId, now),
    ]);
    if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new FloorConflictError("An agent with that name already exists.");
    throw error;
  }
  return readFloorSnapshot(sessionId, userId, database);
}

const ANSWER_AGENT_NAME = "Concierge";
const ANSWER_AGENT_ROLE = "Session answers";
const ANSWER_AGENT_TASK = "Answer questions about this session and its repository.";
const WORKER_AGENT_NAME = "Auto Worker";
const WORKER_AGENT_ROLE = "Auto-provisioned engineer";
const GENERATED_AGENT_NAME_ATTEMPTS = 100;

// Generated agents are persisted for attribution but activated only while
// the router has work for them. Their fixed metadata is system-owned. Kind,
// never name, distinguishes Concierge from a persistent agent with the same
// name; collisions therefore suffix the generated name safely.
//
// Callers are the per-session SessionRouter Durable Object's alarm(), which
// never overlaps itself, so concurrent creation within one session is not a
// practical race; the loop below is defensive, not load-bearing.
export async function ensureAnswerAgent(
  sessionId: string,
  ownerUserId: string,
  provider: import("@/lib/provider-credentials").CredentialProvider,
  database: D1DatabaseLike = getDb(),
  unavailableAgentIds: readonly string[] = [],
): Promise<{ id: string; name: string; changed: boolean }> {
  return provisionGeneratedAgent(sessionId, ownerUserId, provider, "answer", ANSWER_AGENT_TASK, database, unavailableAgentIds);
}

export async function ensureWorkerAgent(
  sessionId: string,
  ownerUserId: string,
  provider: import("@/lib/provider-credentials").CredentialProvider,
  task: string,
  database: D1DatabaseLike = getDb(),
): Promise<{ id: string; name: string; changed: boolean }> {
  return provisionGeneratedAgent(sessionId, ownerUserId, provider, "worker", task.slice(0, 1_000), database);
}

async function provisionGeneratedAgent(
  sessionId: string,
  ownerUserId: string,
  provider: import("@/lib/provider-credentials").CredentialProvider,
  kind: "answer" | "worker",
  task: string,
  database: D1DatabaseLike,
  unavailableAgentIds: readonly string[] = [],
): Promise<{ id: string; name: string; changed: boolean }> {
  const availabilityClause = unavailableAgentIds.length > 0
    ? ` AND id NOT IN (${unavailableAgentIds.map(() => "?").join(", ")})`
    : "";
  const active = await database.prepare(
    `SELECT id, name FROM floor_agents WHERE session_id = ? AND kind = ? AND deprovisioned_at IS NULL${availabilityClause} ORDER BY created_at, id LIMIT 1`,
  ).bind(sessionId, kind, ...unavailableAgentIds).first<{ id: string; name: string }>();
  if (active && kind === "answer") return { id: active.id, name: active.name, changed: false };

  const reusable = await database.prepare(
    "SELECT id, name FROM floor_agents WHERE session_id = ? AND kind = ? AND deprovisioned_at IS NOT NULL ORDER BY deprovisioned_at, created_at, id LIMIT 1",
  ).bind(sessionId, kind).first<{ id: string; name: string }>();
  if (reusable) {
    const now = Date.now();
    const result = await database.prepare(
      `UPDATE floor_agents SET owner_user_id = ?, provider = ?, task = ?, deprovisioned_at = NULL, idle_since = NULL, updated_at = ?
       WHERE id = ? AND session_id = ? AND deprovisioned_at IS NOT NULL`,
    ).bind(ownerUserId, provider, task, now, reusable.id, sessionId).run();
    if (Number(result.meta?.changes ?? 0) > 0) return { id: reusable.id, name: reusable.name, changed: true };
  }

  const baseName = kind === "answer" ? ANSWER_AGENT_NAME : WORKER_AGENT_NAME;
  const role = kind === "answer" ? ANSWER_AGENT_ROLE : WORKER_AGENT_ROLE;
  for (let attempt = 0; attempt < GENERATED_AGENT_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName} ${attempt + 1}`;
    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      const result = await database.prepare(
        `INSERT INTO floor_agents
           (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, provider, kind, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
      ).bind(id, sessionId, ownerUserId, ownerUserId, name, normalizeAgentName(name), role, task, provider, kind, now, now, sessionId).run();
      if (Number(result.meta?.changes ?? 0) > 0) return { id, name, changed: true };
      // The session ended between the check above and here; nothing to create.
      throw new FloorTargetError("Session has ended.");
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) continue; // name collision, try the next suffix
      throw error;
    }
  }
  throw new Error(`Could not create a generated ${kind} agent: no available name.`);
}

// How long a generated agent (Concierge or worker) lingers, visibly idle on
// the floor, after finishing its last work before the router retires it.
// Long enough that a reply's speech bubble (AgentCard.tsx) is never yanked
// off the floor mid-read; short enough that idle capacity is still reclaimed
// promptly. See the SessionRouter alarm re-arm this depends on below.
export const GENERATED_AGENT_LINGER_MS = 10_000;

/**
 * Reconcile generated agents after toggles and terminal run transitions.
 * `now` is an explicit parameter (not always `Date.now()`) so a caller — the
 * SessionRouter alarm loop, or a test — can drive the idle clock without a
 * real wall-clock wait.
 */
export async function deprovisionIdleGeneratedAgents(
  sessionId: string,
  autoProvisionEnabled: boolean,
  database: D1DatabaseLike = getDb(),
  now: number = Date.now(),
): Promise<{ changed: boolean; nextRetireAt: number | null }> {
  let changed = false;
  if (!autoProvisionEnabled) {
    const unassigned = await database.prepare(
      `UPDATE floor_queue_items SET agent_id = NULL, assigned_by = NULL, assigned_reason = NULL, updated_at = ?
       WHERE session_id = ? AND assigned_by = 'router' AND status IN ('queued', 'paused')
         AND agent_id IN (SELECT id FROM floor_agents WHERE session_id = ? AND kind IN ('answer', 'worker') AND deprovisioned_at IS NULL)`,
    ).bind(now, sessionId, sessionId).run();
    changed = Number(unassigned.meta?.changes ?? 0) > 0;
    const resetWorkers = await database.prepare(
      `UPDATE floor_agents SET paused_at = NULL, updated_at = ?
       WHERE session_id = ? AND kind = 'worker' AND paused_at IS NOT NULL`,
    ).bind(now, sessionId).run();
    changed = changed || Number(resetWorkers.meta?.changes ?? 0) > 0;
  }
  const protectedQueueStatuses = autoProvisionEnabled
    ? "('queued', 'running', 'blocked', 'paused')"
    : "('running', 'blocked')";
  // "Nothing currently keeps this generated row on the floor" — reused by
  // the stamp/clear/retire statements below so a row's idle clock starts,
  // resets, and expires off one consistent definition of idle. Carries
  // exactly one placeholder (the autoProvisionEnabled flag).
  const eligible = `a.kind IN ('answer', 'worker') AND a.deprovisioned_at IS NULL
       AND (? = 0 OR a.kind != 'worker' OR a.paused_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM floor_queue_items q WHERE q.agent_id = a.id AND q.status IN ${protectedQueueStatuses})
       AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.agent_id = a.id AND r.status IN ('provisioning', 'running', 'checking', 'cancel_requested', 'publishing', 'published', 'integrating'))`;
  const autoProvisionFlag = autoProvisionEnabled ? 1 : 0;

  // 1. Start the grace clock the instant a row first becomes idle.
  await database.prepare(
    `UPDATE floor_agents AS a SET idle_since = ?, updated_at = ?
     WHERE a.session_id = ? AND a.idle_since IS NULL AND ${eligible}`,
  ).bind(now, now, sessionId, autoProvisionFlag).run();

  // 2. A row that picked up new work before its grace window elapsed is no
  // longer eligible — reset its clock so the next time it goes idle starts a
  // fresh window instead of retiring instantly off a stale timestamp.
  await database.prepare(
    `UPDATE floor_agents AS a SET idle_since = NULL, updated_at = ?
     WHERE a.session_id = ? AND a.kind IN ('answer', 'worker') AND a.deprovisioned_at IS NULL
       AND a.idle_since IS NOT NULL AND NOT (${eligible})`,
  ).bind(now, sessionId, autoProvisionFlag).run();

  // 3. Retire only once the grace window has actually elapsed.
  const retired = await database.prepare(
    `UPDATE floor_agents AS a SET deprovisioned_at = ?, idle_since = NULL, updated_at = ?
     WHERE a.session_id = ? AND a.idle_since IS NOT NULL AND a.idle_since <= ? AND ${eligible}`,
  ).bind(now, now, sessionId, now - GENERATED_AGENT_LINGER_MS, autoProvisionFlag).run();
  changed = changed || Number(retired.meta?.changes ?? 0) > 0;

  // Any row still waiting out its grace window needs a future wake so
  // retirement actually fires without depending on an unrelated poke.
  const earliestIdle = await database.prepare(
    `SELECT MIN(idle_since) AS earliest FROM floor_agents
     WHERE session_id = ? AND kind IN ('answer', 'worker') AND deprovisioned_at IS NULL AND idle_since IS NOT NULL`,
  ).bind(sessionId).first<{ earliest: number | null }>();
  const nextRetireAt = earliestIdle?.earliest != null ? earliestIdle.earliest + GENERATED_AGENT_LINGER_MS : null;

  return { changed, nextRetireAt };
}

/**
 * Field edits on a persistent agent — task, model, and billing credential
 * kind — one route, one function, SET clause built from the keys present.
 * Generalizes the old updateFloorAgentTask; every guard it had stays:
 * membership, kind IS NULL, deprovisioned_at IS NULL, session-not-ended,
 * bumpFloorRevision, and the changes === 0 re-check distinguishing "not a
 * member" from "not an editable agent".
 *
 * model/credentialKind validate against the agent's STORED provider read
 * here, never a client-supplied one. No lock is needed for that read:
 * provider is immutable for persistent agents — the only UPDATE touching it
 * (the generated-agent reuse path) is unreachable behind this function's
 * kind IS NULL guard.
 *
 * A credentialKind change is refused (409) while the agent has a real
 * in-flight run: the gateway resolves the billing credential live on EVERY
 * proxied request, so applying it mid-run would silently switch whose
 * credential the run's next request bills — the exact thing the
 * never-silently-switch-payer invariant forbids. A model change needs no
 * such guard, and must not grow one for symmetry: the model was frozen into
 * agent_runs.model at run creation, so editing it can never disturb an
 * in-flight run.
 */
export async function updateFloorAgentSettings(
  sessionId: string,
  userId: string,
  agentId: string,
  patch: AgentSettingsInput,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  const agent = await database.prepare(
    "SELECT provider, owner_user_id AS ownerUserId FROM floor_agents WHERE id = ? AND session_id = ? AND kind IS NULL AND deprovisioned_at IS NULL",
  ).bind(agentId, sessionId).first<{ provider: CredentialProvider; ownerUserId: string }>();
  if (!agent) throw new FloorTargetError("Only active, persistent agents can be edited.");
  if ((patch.model !== undefined || patch.credentialKind !== undefined) && agent.ownerUserId !== userId) {
    throw new FloorTargetError("Only this agent's owner can change its model or billing.");
  }
  if (patch.model !== undefined && patch.model !== null && !PROVIDER_MODELS[agent.provider].includes(patch.model)) {
    throw new FloorTargetError("That model is not available for this agent's provider.");
  }
  if (patch.credentialKind !== undefined && patch.credentialKind !== null && !credentialKindsForProvider(agent.provider).includes(patch.credentialKind)) {
    throw new FloorTargetError("That billing option is not available for this agent's provider.");
  }
  if (patch.credentialKind !== undefined) {
    const activeRun = await database.prepare(
      `SELECT 1 AS present FROM agent_runs WHERE session_id = ? AND agent_id = ? AND status IN ${AGENT_ACTIVE_RUN_STATUSES}`,
    ).bind(sessionId, agentId).first<{ present: number }>();
    if (activeRun) throw new FloorConflictError("This agent has a run in flight — stop it or wait for it to finish before changing its billing.");
  }
  const now = Date.now();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.task !== undefined) { sets.push("task = ?"); binds.push(patch.task); }
  if (patch.model !== undefined) { sets.push("model = ?"); binds.push(patch.model); }
  if (patch.credentialKind !== undefined) { sets.push("credential_kind = ?"); binds.push(patch.credentialKind); }
  const result = await database.prepare(
    `UPDATE floor_agents SET ${sets.join(", ")}, updated_at = ?
     WHERE id = ? AND session_id = ? AND kind IS NULL AND deprovisioned_at IS NULL
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
  ).bind(...binds, now, agentId, sessionId, sessionId).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
    throw new FloorTargetError("Only active, persistent agents can be edited.");
  }
  await bumpFloorRevision(database, sessionId, now).run();
  return readFloorSnapshot(sessionId, userId, database);
}

// Statuses agent_runs uses for the run-cancellation write path
// (requestAgentRunCancellation in db/runs.ts accepts exactly this set).
const CANCELLABLE_RUN_STATUSES = "('provisioning', 'running', 'checking', 'integrating')";
// Broader "has real in-flight work" set used to refuse a delete outright —
// includes cancel_requested (already mid-cancellation) so a second delete
// attempt doesn't race the workflow's own cleanup.
const AGENT_ACTIVE_RUN_STATUSES = "('provisioning', 'running', 'checking', 'cancel_requested', 'integrating')";

/**
 * Manual start/pause for a persistent agent or generated worker. Any session member may call
 * this — unlike run cancellation, pausing never touches an in-flight run,
 * it only blocks the router from assigning/dispatching new work to this
 * agent (db/routing.ts filters `paused_at IS NULL`). System-managed
 * Concierge agents remain router-controlled and excluded here.
 */
export async function pauseFloorAgent(
  sessionId: string,
  userId: string,
  agentId: string,
  paused: boolean,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  const role = await getActiveMembershipRole(sessionId, userId, database);
  if (!role) return null;
  if (!paused) {
    const owner = await database.prepare(
      "SELECT owner_user_id AS ownerUserId FROM floor_agents WHERE id = ? AND session_id = ? AND (kind IS NULL OR kind = 'worker') AND deprovisioned_at IS NULL",
    ).bind(agentId, sessionId).first<{ ownerUserId: string }>();
    if (owner && owner.ownerUserId !== userId) throw new FloorTargetError("Only this agent's owner can resume it.");
  }
  const now = Date.now();
  const result = await database.prepare(
    `UPDATE floor_agents SET paused_at = ?, updated_at = ?
     WHERE id = ? AND session_id = ? AND (kind IS NULL OR kind = 'worker') AND deprovisioned_at IS NULL
       AND paused_at IS ${paused ? "NULL" : "NOT NULL"}
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
  ).bind(paused ? now : null, now, agentId, sessionId, sessionId).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
    throw new FloorConflictError(paused ? "This agent is already paused, is a Concierge, or was removed." : "This agent is not paused.");
  }
  await bumpFloorRevision(database, sessionId, now).run();
  return readFloorSnapshot(sessionId, userId, database);
}

/**
 * Any member may Stop an agent: it always blocks new dispatch immediately
 * (same effect as pauseFloorAgent(..., true)). Cancelling an in-flight run
 * is a separate, owner-only privilege (agent_runs' documented invariant —
 * "the owner may start or cancel; members receive no run mutation
 * controls") so a non-owner's Stop leaves an active run to finish, exactly
 * like Pause would; an owner's Stop also cancels it via the existing
 * requestAgentRunCancellation.
 */
export async function stopFloorAgent(
  sessionId: string,
  userId: string,
  agentId: string,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  const role = await getActiveMembershipRole(sessionId, userId, database);
  if (!role) return null;
  const now = Date.now();
  const result = await database.prepare(
    `UPDATE floor_agents SET paused_at = COALESCE(paused_at, ?), updated_at = ?
     WHERE id = ? AND session_id = ? AND (kind IS NULL OR kind = 'worker') AND deprovisioned_at IS NULL
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
  ).bind(now, now, agentId, sessionId, sessionId).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
    throw new FloorTargetError("This agent cannot be stopped.");
  }
  if (role === "owner") {
    const activeRun = await database.prepare(
      `SELECT id FROM agent_runs WHERE session_id = ? AND agent_id = ? AND status IN ${CANCELLABLE_RUN_STATUSES}`,
    ).bind(sessionId, agentId).first<{ id: string }>();
    if (activeRun) await requestAgentRunCancellation(sessionId, activeRun.id, userId, database);
  }
  await bumpFloorRevision(database, sessionId, now).run();
  return readFloorSnapshot(sessionId, userId, database);
}

/**
 * Soft-deletes a persistent agent (deprovisioned_at, same column the
 * auto-provisioning lifecycle uses for system agents) and unassigns it from
 * any still-queued/paused items so the router can re-route them. Refuses
 * while the agent has real in-flight work — stop it first.
 */
export async function deleteFloorAgent(
  sessionId: string,
  userId: string,
  agentId: string,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  const activeRun = await database.prepare(
    `SELECT 1 AS present FROM agent_runs WHERE session_id = ? AND agent_id = ? AND status IN ${AGENT_ACTIVE_RUN_STATUSES}`,
  ).bind(sessionId, agentId).first<{ present: number }>();
  if (activeRun) throw new FloorConflictError("Stop this agent's run before deleting it.");
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `UPDATE floor_queue_items SET agent_id = NULL, assigned_by = NULL, assigned_reason = NULL, updated_at = ?
       WHERE session_id = ? AND agent_id = ? AND status IN ('queued', 'paused')`,
    ).bind(now, sessionId, agentId),
    database.prepare(
      `UPDATE floor_agents SET deprovisioned_at = ?, updated_at = ?
       WHERE id = ? AND session_id = ? AND kind IS NULL AND deprovisioned_at IS NULL
         AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(now, now, agentId, sessionId, sessionId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) === 0) {
    if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
    throw new FloorConflictError("This agent no longer exists or cannot be removed.");
  }
  return readFloorSnapshot(sessionId, userId, database);
}

/** Owner-only bulk lever over the "any member" per-agent buttons above. */
export async function pauseAllFloorAgents(sessionId: string, userId: string, database = getDb()): Promise<FloorSnapshot | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE floor_agents SET paused_at = ?, updated_at = ?
       WHERE session_id = ? AND (kind IS NULL OR kind = 'worker') AND deprovisioned_at IS NULL AND paused_at IS NULL
         AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(now, now, sessionId, sessionId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  return readFloorSnapshot(sessionId, userId, database);
}

export async function resumeAllFloorAgents(sessionId: string, userId: string, database = getDb()): Promise<FloorSnapshot | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE floor_agents SET paused_at = NULL, updated_at = ?
       WHERE session_id = ? AND (kind IS NULL OR kind = 'worker') AND owner_user_id = ? AND deprovisioned_at IS NULL AND paused_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(now, sessionId, userId, sessionId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  return readFloorSnapshot(sessionId, userId, database);
}

/** Bulk Stop: pauses every persistent agent and generated worker and cancels every run it has
 * active, reusing requestAgentRunCancellation per run — a strict superset
 * of individual Stop, no new authorization surface. */
export async function stopAllFloorAgents(sessionId: string, userId: string, database = getDb()): Promise<FloorSnapshot | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const now = Date.now();
  await database.prepare(
    `UPDATE floor_agents SET paused_at = ?, updated_at = ?
     WHERE session_id = ? AND (kind IS NULL OR kind = 'worker') AND deprovisioned_at IS NULL AND paused_at IS NULL
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
  ).bind(now, now, sessionId, sessionId).run();
  const activeRuns = await database.prepare(
    `SELECT r.id FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id
     WHERE r.session_id = ? AND (a.kind IS NULL OR a.kind = 'worker') AND r.status IN ${CANCELLABLE_RUN_STATUSES}`,
  ).bind(sessionId).all<{ id: string }>();
  for (const run of activeRuns.results) await requestAgentRunCancellation(sessionId, run.id, userId, database);
  await bumpFloorRevision(database, sessionId, now).run();
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
  const messageId = crypto.randomUUID();
  const statements = [
    database.prepare(
      `INSERT INTO floor_messages (id, session_id, author_user_id, recipient_user_id, text, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
    ).bind(messageId, sessionId, userId, input.recipientUserId, input.text, now, sessionId),
  ];
  // Claim the sender's own still-unattached uploads for this message, in the
  // same batch as the insert. The WHERE clauses make a stale or foreign id a
  // silent no-op rather than a cross-session or cross-user link (validation
  // already refused attachments on DMs).
  const attachmentIds = input.attachmentIds ?? [];
  if (attachmentIds.length > 0) {
    statements.push(
      database.prepare(
        `UPDATE session_files SET message_id = ?
         WHERE session_id = ? AND uploaded_by_user_id = ? AND message_id IS NULL
           AND id IN (${attachmentIds.map(() => "?").join(",")})
           AND EXISTS (SELECT 1 FROM floor_messages WHERE id = ?)`,
      ).bind(messageId, sessionId, userId, ...attachmentIds, messageId),
    );
  }
  // Last on purpose: activeBatchApplied reads the final statement's changes,
  // and the revision bump is the ended-session detector.
  statements.push(bumpFloorRevision(database, sessionId, now));
  const results = await database.batch(statements);
  if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

// Records uploads whose bytes the caller already put in R2 (ENG-113). The
// same ended-session INSERT...SELECT guard as every floor mutation; the
// caller unwinds its R2 objects when this returns null.
export async function createSessionFiles(
  sessionId: string,
  userId: string,
  files: { id: string; name: string; r2Key: string; contentType: string; sizeBytes: number }[],
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  const now = Date.now();
  const results = await database.batch([
    ...files.map((file) =>
      database.prepare(
        `INSERT INTO session_files (id, session_id, uploaded_by_user_id, message_id, name, r2_key, content_type, size_bytes, created_at)
         SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
      ).bind(file.id, sessionId, userId, file.name, file.r2Key, file.contentType, file.sizeBytes, now, sessionId),
    ),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (!(await activeBatchApplied(results, sessionId, userId, database))) return null;
  return readFloorSnapshot(sessionId, userId, database);
}

// The serve route's authorization read: membership first, then the row,
// scoped by session so a file id can never cross sessions.
export async function getSessionFileForMember(
  sessionId: string,
  fileId: string,
  userId: string,
  database = getDb(),
): Promise<{ r2Key: string; name: string; contentType: string } | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const row = await database.prepare(
    "SELECT r2_key AS r2Key, name, content_type AS contentType FROM session_files WHERE session_id = ? AND id = ?",
  ).bind(sessionId, fileId).first<{ r2Key: string; name: string; contentType: string }>();
  return row ?? null;
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
    "SELECT COALESCE(MAX(position), 0) AS position FROM floor_queue_items WHERE session_id = ? AND dismissed_at IS NULL",
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

/* Prompt-level write access: the session owner may act on any prompt, and any
   other member may only act on a queue item whose prompts are entirely their
   own. */
async function canManageQueueItem(sessionId: string, userId: string, itemId: string, database: D1DatabaseLike): Promise<boolean> {
  const role = await getActiveMembershipRole(sessionId, userId, database);
  if (!role) return false;
  if (role === "owner") return true;
  const authors = await database.prepare(
    "SELECT DISTINCT author_user_id AS authorUserId FROM floor_queue_prompts WHERE queue_item_id = ?",
  ).bind(itemId).all<{ authorUserId: string }>();
  return authors.results.length > 0 && authors.results.every((row) => row.authorUserId === userId);
}

export async function updateFloorQueuePrompt(
  sessionId: string,
  userId: string,
  itemId: string,
  promptId: string,
  text: string,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await canManageQueueItem(sessionId, userId, itemId, database))) return null;
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `UPDATE floor_queue_prompts SET text = ? WHERE id = ? AND queue_item_id = ?
       AND EXISTS (SELECT 1 FROM floor_queue_items WHERE id = ? AND session_id = ? AND status IN ('queued', 'paused') AND dismissed_at IS NULL)`,
    ).bind(text, promptId, itemId, itemId, sessionId),
    database.prepare(`UPDATE floor_queue_items SET updated_at = ? WHERE id = ?`).bind(now, itemId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 0) {
    if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
    throw new FloorConflictError("This prompt can no longer be edited.");
  }
  return readFloorSnapshot(sessionId, userId, database);
}

export async function setFloorQueueItemPaused(
  sessionId: string,
  userId: string,
  itemId: string,
  paused: boolean,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await canManageQueueItem(sessionId, userId, itemId, database))) return null;
  const now = Date.now();
  // Resuming also doubles as the recovery path off a failed/cancelled prompt,
  // since neither of those is auto-retried anymore (see db/runs.ts finishAgentRun).
  const fromStatuses = paused ? ["queued"] : ["paused", "failed", "cancelled"];
  const results = await database.batch([
    database.prepare(
      `UPDATE floor_queue_items SET status = ?, updated_at = ? WHERE id = ? AND session_id = ?
       AND status IN (${fromStatuses.map(() => "?").join(", ")}) AND dismissed_at IS NULL`,
    ).bind(paused ? "paused" : "queued", now, itemId, sessionId, ...fromStatuses),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 0) {
    if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
    throw new FloorConflictError(paused ? "This prompt is not queued." : "This prompt is not paused, failed, or cancelled.");
  }
  return readFloorSnapshot(sessionId, userId, database);
}

// Gives an unassigned queued item a target so it can be Run manually — the
// only other assigner is the router's assign phase, which never runs while
// auto-dispatch is off, so a targetless prompt otherwise had no way to reach
// a Run button (PromptQueue.tsx's Run condition requires item.agentId).
export async function setFloorQueueItemAgent(
  sessionId: string,
  userId: string,
  itemId: string,
  agentId: string,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await canManageQueueItem(sessionId, userId, itemId, database))) return null;
  if (!(await isSessionAgent(sessionId, agentId, database))) {
    throw new FloorTargetError("Queue target must belong to this session.");
  }
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `UPDATE floor_queue_items SET agent_id = ?, assigned_by = 'user', assigned_reason = NULL, updated_at = ?
       WHERE id = ? AND session_id = ? AND status = 'queued' AND agent_id IS NULL AND dismissed_at IS NULL`,
    ).bind(agentId, now, itemId, sessionId),
    bumpFloorRevision(database, sessionId, now),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 0) {
    if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
    throw new FloorConflictError("This prompt already has a target, or is no longer queued.");
  }
  return readFloorSnapshot(sessionId, userId, database);
}

// Soft-delete: agent_runs.queue_item_id has no ON DELETE cascade (agent_runs
// keeps four inbound cascades already — see its schema comment — so adding
// one more here would force a table recreate against production data). A
// failed/cancelled item always has a run row, so a hard DELETE on it raised
// a raw FOREIGN KEY constraint failure, which the client misreported as
// "The floor could not be reached." Dismissal preserves the run's audit
// history and simply hides the item; every queue read and mutation guard
// filters on dismissed_at IS NULL.
export async function deleteFloorQueueItem(
  sessionId: string,
  userId: string,
  itemId: string,
  database = getDb(),
): Promise<FloorSnapshot | null> {
  if (!(await canManageQueueItem(sessionId, userId, itemId, database))) return null;
  const item = await database.prepare("SELECT status, dismissed_at AS dismissedAt FROM floor_queue_items WHERE id = ? AND session_id = ?")
    .bind(itemId, sessionId).first<{ status: string; dismissedAt: number | null }>();
  if (!item) return null;
  if (!["queued", "paused", "failed", "cancelled"].includes(item.status) || item.dismissedAt !== null) {
    throw new FloorConflictError("This prompt can no longer be removed.");
  }
  const remaining = (await queueIds(sessionId, database)).filter((id) => id !== itemId);
  const now = Date.now();
  const results = await database.batch([
    database.prepare("UPDATE floor_queue_items SET dismissed_at = ?, updated_at = ? WHERE id = ? AND session_id = ? AND dismissed_at IS NULL")
      .bind(now, now, itemId, sessionId),
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
    "SELECT 1 AS present FROM session_members WHERE session_id = ? AND user_id = ? AND removed_at IS NULL",
  ).bind(sessionId, userId).first<{ present: number }>();
  return Boolean(row);
}

async function isSessionAgent(sessionId: string, agentId: string, database: D1DatabaseLike) {
  const row = await database.prepare(
    "SELECT 1 AS present FROM floor_agents WHERE session_id = ? AND id = ? AND deprovisioned_at IS NULL",
  ).bind(sessionId, agentId).first<{ present: number }>();
  return Boolean(row);
}

async function queueIds(sessionId: string, database: D1DatabaseLike) {
  const result = await database.prepare(
    "SELECT id FROM floor_queue_items WHERE session_id = ? AND dismissed_at IS NULL ORDER BY position, created_at, id",
  ).bind(sessionId).all<{ id: string }>();
  return result.results.map((row) => row.id);
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

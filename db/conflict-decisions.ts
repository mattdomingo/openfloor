import { getDb } from "./index";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";
import { MAX_AUTOMATIC_CONFLICT_ATTEMPTS, proposalApproval, type ConflictMode, type ConflictProposalPayload, type ConflictProvenance, type ConflictResolution, type ConflictVote } from "@/lib/conflict-resolution";

type Database = ReturnType<typeof getDb>;
const emptyProvenance: ConflictProvenance = { incoming: [], integrated: [], requiresOwner: true };

export async function conflictAccess(sessionId: string, caseId: string, userId: string, write: boolean, database: Database) {
  const bound = await database.prepare("SELECT id FROM merge_conflict_cases WHERE id = ? AND session_id = ?").bind(caseId, sessionId).first();
  if (!bound) return null;
  return write ? getActiveMembershipRole(sessionId, userId, database) : getMembershipRole(sessionId, userId, database);
}

export async function getConflictResolutionViews(sessionId: string, database = getDb()): Promise<Map<string, ConflictResolution>> {
  const [cases, voteRows, members] = await Promise.all([
    database.prepare(`SELECT mc.id, mc.revision, mc.trigger, mc.mode, mc.snapshot_id AS snapshotId, mc.waiting_reason AS waitingReason,
      sn.candidate_sha AS candidateSha, sn.provenance, p.id AS proposalId, p.payload, p.created_by AS createdBy,
      (SELECT assessment FROM merge_conflict_attempts a WHERE a.case_id = mc.id AND a.snapshot_id = mc.snapshot_id AND a.assessment IS NOT NULL ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS assessment
      FROM merge_conflict_cases mc LEFT JOIN merge_conflict_snapshots sn ON sn.id = mc.snapshot_id AND sn.case_id = mc.id
      LEFT JOIN merge_conflict_proposals p ON p.id = mc.proposal_id AND p.snapshot_id = mc.snapshot_id AND p.case_id = mc.id
      WHERE mc.session_id = ?`).bind(sessionId).all<{
        id: string; assessment: string | null; revision: number; trigger: "git" | "overlap"; mode: ConflictMode; snapshotId: string | null; waitingReason: string | null;
        candidateSha: string | null; provenance: string | null; proposalId: string | null; payload: string | null; createdBy: string | null;
      }>(),
    database.prepare(`SELECT v.proposal_id AS proposalId, v.user_id AS userId, u.display_name AS name, v.action, v.reason, v.created_at AS createdAt
      FROM merge_conflict_votes v JOIN merge_conflict_proposals p ON p.id = v.proposal_id
      JOIN merge_conflict_cases mc ON mc.proposal_id = p.id LEFT JOIN users u ON u.id = v.user_id
      WHERE mc.session_id = ? ORDER BY v.case_revision, v.id`).bind(sessionId).all<ConflictVote & { proposalId: string }>(),
    database.prepare("SELECT user_id AS id FROM session_members WHERE session_id = ? AND removed_at IS NULL").bind(sessionId).all<{ id: string }>(),
  ]);
  const votes = new Map<string, ConflictVote[]>();
  for (const { proposalId, ...vote } of voteRows.results) votes.set(proposalId, [...(votes.get(proposalId) ?? []), vote]);
  return new Map(cases.results.map((row) => {
    const provenance: ConflictProvenance = row.provenance ? JSON.parse(row.provenance) : emptyProvenance;
    const proposalVotes = row.proposalId ? votes.get(row.proposalId) ?? [] : [];
    return [row.id, {
      revision: Number(row.revision), trigger: row.trigger, mode: row.mode, snapshotId: row.snapshotId,
      candidateSha: row.candidateSha, provenance, waitingReason: row.waitingReason,
      assessment: row.assessment ? JSON.parse(row.assessment) as import("@/lib/conflict-resolution").ConflictAssessment : null,
      proposal: row.proposalId && row.payload ? {
        id: row.proposalId, payload: JSON.parse(row.payload) as ConflictProposalPayload, createdBy: row.createdBy,
        votes: proposalVotes, ...proposalApproval(provenance, members.results.map((member) => member.id), proposalVotes),
      } : null,
    }];
  }));
}

export async function getConflictDecisionView(sessionId: string, caseId: string, userId: string, database = getDb()) {
  const role = await conflictAccess(sessionId, caseId, userId, false, database);
  if (!role) return null;
  const resolution = (await getConflictResolutionViews(sessionId, database)).get(caseId);
  if (!resolution) return null;
  const authorIds = new Set([...resolution.provenance.incoming, ...resolution.provenance.integrated].map((prompt) => prompt.authorUserId));
  if (!resolution.snapshotId) {
    const original = await database.prepare(`SELECT p.author_user_id AS id FROM merge_conflict_cases mc
      JOIN agent_runs r ON r.id = mc.source_run_id JOIN floor_queue_prompts p ON p.queue_item_id = r.queue_item_id
      WHERE mc.id = ? AND mc.session_id = ?`).bind(caseId, sessionId).all<{ id: string }>();
    original.results.forEach((author) => authorIds.add(author.id));
  }
  return { resolution, canPropose: role === "owner" || authorIds.has(userId), canOverride: role === "owner" };
}

// The first statement claims a unique operation token in the same D1 batch.
// Every dependent write tests that token; a losing CAS therefore writes nothing.
function claimMutation(database: Database, input: { sessionId: string; caseId: string; userId: string; revision: number; token: string; snapshotId: string }) {
  return database.prepare(`UPDATE merge_conflict_cases SET mutation_id = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND session_id = ? AND revision = ? AND snapshot_id = ?
      AND current_resolver_run_id IS NULL AND status IN ('pending', 'failed', 'awaiting_input')
      AND EXISTS (SELECT 1 FROM sessions s JOIN session_members sm ON sm.session_id = s.id
        WHERE s.id = ? AND s.ended_at IS NULL AND sm.user_id = ? AND sm.removed_at IS NULL)
      AND EXISTS (SELECT 1 FROM merge_conflict_snapshots sn JOIN agent_runs source ON source.id = sn.source_run_id
        JOIN repository_candidates c ON c.id = source.candidate_id JOIN repository_connections rc ON rc.id = c.connection_id
        WHERE sn.id = ? AND c.status = 'active' AND c.merged_at IS NULL AND rc.status = 'ready'
          AND c.candidate_sha = sn.candidate_sha AND c.remote_candidate_sha = sn.candidate_sha)`)
    .bind(input.token, Date.now(), input.caseId, input.sessionId, input.revision, input.snapshotId, input.sessionId, input.userId, input.snapshotId);
}
function bump(database: Database, sessionId: string, caseId: string, token: string) {
  return database.prepare(`UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ?
    WHERE id = ? AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`)
    .bind(Date.now(), sessionId, caseId, token);
}

export async function proposeConflictResolution(input: {
  sessionId: string; caseId: string; userId: string; revision: number; snapshotId: string; payload: ConflictProposalPayload;
}, database = getDb()): Promise<"recorded" | "stale" | "missing"> {
  const role = await conflictAccess(input.sessionId, input.caseId, input.userId, true, database);
  if (!role) return "missing";
  const view = await getConflictDecisionView(input.sessionId, input.caseId, input.userId, database);
  if (!view?.canPropose) return "missing";
  if (view.resolution.snapshotId !== input.snapshotId) return "stale";
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = Date.now();
  const results = await database.batch([
    claimMutation(database, { ...input, token }),
    database.prepare(`INSERT INTO merge_conflict_proposals (id, case_id, snapshot_id, kind, payload, created_by, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`)
      .bind(id, input.caseId, input.snapshotId, input.payload.kind, JSON.stringify(input.payload), input.userId, now, input.caseId, token),
    database.prepare(`INSERT INTO merge_conflict_votes (id, proposal_id, user_id, action, case_revision, created_at)
      SELECT ?, ?, ?, 'approve', ?, ? WHERE EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`)
      .bind(crypto.randomUUID(), id, input.userId, input.revision + 1, now, input.caseId, token),
    database.prepare(`UPDATE merge_conflict_cases SET proposal_id = ?, status = 'awaiting_input', resume_requested = 0,
      mode = ?, waiting_reason = 'Waiting for affected authors to approve the same proposal.', failure_reason = NULL
      WHERE id = ? AND mutation_id = ?`).bind(id, input.payload.kind === "manual" ? "manual" : "ai", input.caseId, token),
    bump(database, input.sessionId, input.caseId, token),
  ]);
  if (Number(results[0].meta?.changes ?? 0) !== 1) return "stale";
  await queueApprovedProposal(input.sessionId, input.caseId, database);
  return "recorded";
}

export async function voteConflictProposal(input: {
  sessionId: string; caseId: string; userId: string; revision: number; proposalId: string;
  action: "approve" | "reject" | "override"; reason?: string;
}, database = getDb()): Promise<"recorded" | "stale" | "missing"> {
  const role = await conflictAccess(input.sessionId, input.caseId, input.userId, true, database);
  if (!role) return "missing";
  if (input.action === "override" && (!input.reason?.trim() || input.reason.length > 2000)) return "stale";
  const view = await getConflictDecisionView(input.sessionId, input.caseId, input.userId, database);
  if (!view?.canPropose || input.action === "override" && role !== "owner") return "missing";
  if (!view.resolution.snapshotId || view.resolution.proposal?.id !== input.proposalId) return "stale";
  const token = crypto.randomUUID();
  const results = await database.batch([
    claimMutation(database, { ...input, snapshotId: view.resolution.snapshotId, token }),
    database.prepare(`INSERT INTO merge_conflict_votes (id, proposal_id, user_id, action, reason, case_revision, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ? AND proposal_id = ?)`)
      .bind(crypto.randomUUID(), input.proposalId, input.userId, input.action, input.reason ?? null, input.revision + 1, Date.now(), input.caseId, token, input.proposalId),
    database.prepare(`UPDATE merge_conflict_cases SET waiting_reason = ?, status = 'awaiting_input', resume_requested = 0
      WHERE id = ? AND mutation_id = ?`).bind(input.action === "reject" ? "An affected author disagrees. Revise the proposal or request an explicit owner decision." : "Waiting for affected authors to approve the same proposal.", input.caseId, token),
    bump(database, input.sessionId, input.caseId, token),
  ]);
  if (Number(results[0].meta?.changes ?? 0) !== 1) return "stale";
  await queueApprovedProposal(input.sessionId, input.caseId, database);
  return "recorded";
}

export async function queueApprovedProposal(sessionId: string, caseId: string, database = getDb()) {
  const view = (await getConflictResolutionViews(sessionId, database)).get(caseId);
  if (!view?.proposal?.approved) return false;
  const required = view.proposal.requiredAuthorIds;
  const hasOverride = view.proposal.votes.some((vote) => vote.action === "override");
  const history = await database.prepare(`SELECT COUNT(*) AS count FROM merge_conflict_attempts
    WHERE case_id = ? AND snapshot_id = ? AND proposal_id = ? AND execution_mode = 'ai'`)
    .bind(caseId, view.snapshotId, view.proposal.id).first<{ count: number }>();
  const attempts = Number(history?.count ?? 0);
  const exhausted = view.mode === "ai" && attempts >= MAX_AUTOMATIC_CONFLICT_ATTEMPTS;
  const statements = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET status = ?, resume_requested = ?, automatic_attempts = ?, revision = revision + 1,
      waiting_reason = ?, failure_reason = NULL, updated_at = ?
      WHERE id = ? AND revision = ? AND proposal_id = ? AND status = 'awaiting_input' AND current_resolver_run_id IS NULL
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)
      AND EXISTS (SELECT 1 FROM merge_conflict_snapshots sn JOIN agent_runs source ON source.id = sn.source_run_id
        JOIN repository_candidates c ON c.id = source.candidate_id JOIN repository_connections rc ON rc.id = c.connection_id
        WHERE sn.id = merge_conflict_cases.snapshot_id AND c.status = 'active' AND c.merged_at IS NULL AND rc.status = 'ready'
          AND c.candidate_sha = sn.candidate_sha AND c.remote_candidate_sha = sn.candidate_sha)
      AND (? = 1 OR (SELECT COUNT(*) FROM session_members WHERE session_id = ? AND removed_at IS NULL
        AND user_id IN (SELECT value FROM json_each(?))) = ?)`)
      .bind(exhausted ? "failed" : "pending", exhausted ? 0 : 1, attempts, exhausted ? "Both AI attempts for this proposal are exhausted. Propose a revised outcome or an exact manual result." : null, Date.now(), caseId, view.revision, view.proposal.id, sessionId, hasOverride ? 1 : 0, sessionId, JSON.stringify(required), required.length),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1 WHERE id = ? AND changes() = 1").bind(sessionId),
  ]);
  return Number(statements[0].meta?.changes ?? 0) === 1;
}

export async function conflictProvenance(caseId: string, paths: string[], database = getDb()): Promise<ConflictProvenance> {
  const [incoming, integrated, covered] = await Promise.all([
    database.prepare(`SELECT p.id, p.author_user_id AS authorUserId, u.display_name AS authorName, p.text, source.id AS runId
      FROM merge_conflict_cases mc JOIN agent_runs source ON source.id = mc.source_run_id
      JOIN floor_queue_prompts p ON p.queue_item_id = source.queue_item_id JOIN users u ON u.id = p.author_user_id
      WHERE mc.id = ? ORDER BY p.created_at, p.id`).bind(caseId).all<ConflictProvenance["incoming"][number]>(),
    database.prepare(`SELECT DISTINCT p.id, p.author_user_id AS authorUserId, u.display_name AS authorName, p.text, r.id AS runId
      FROM merge_conflict_cases mc JOIN agent_runs source ON source.id = mc.source_run_id
      JOIN agent_runs r ON r.candidate_id = source.candidate_id AND r.status = 'integrated'
      JOIN agent_run_files f ON f.run_id = r.id JOIN floor_queue_prompts p ON p.queue_item_id = r.queue_item_id
      JOIN users u ON u.id = p.author_user_id
      WHERE mc.id = ? AND f.path IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM agent_run_rollbacks rb WHERE rb.run_id = r.id AND rb.status = 'completed')
      ORDER BY r.integrated_at, r.id, p.id`).bind(caseId, JSON.stringify(paths)).all<ConflictProvenance["integrated"][number]>(),
    database.prepare(`SELECT DISTINCT f.path FROM merge_conflict_cases mc JOIN agent_runs source ON source.id = mc.source_run_id
      JOIN agent_runs r ON r.candidate_id = source.candidate_id AND r.status = 'integrated' JOIN agent_run_files f ON f.run_id = r.id
      WHERE mc.id = ? AND f.path IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM agent_run_rollbacks rb WHERE rb.run_id = r.id AND rb.status = 'completed')`)
      .bind(caseId, JSON.stringify(paths)).all<{ path: string }>(),
  ]);
  return { incoming: incoming.results, integrated: integrated.results,
    requiresOwner: incoming.results.length === 0 || paths.some((path) => !covered.results.some((file) => file.path === path)) };
}

export async function recordPreparedConflict(input: { runId: string; manifestKey: string; paths: string[] }, database = getDb()) {
  const context = await database.prepare(`SELECT mc.id AS caseId, mc.session_id AS sessionId, mc.automatic_attempts AS attempts,
      source.id AS sourceRunId, r.candidate_sha AS candidateSha, source.local_commit_sha AS sourceCommitSha,
      s.auto_resolve_conflicts AS autoResolve, c.candidate_sha AS currentCandidateSha, c.remote_candidate_sha AS remoteCandidateSha
    FROM merge_conflict_attempts a JOIN merge_conflict_cases mc ON mc.id = a.case_id AND mc.current_resolver_run_id = a.run_id
    JOIN agent_runs r ON r.id = a.run_id JOIN agent_runs source ON source.id = COALESCE(a.source_run_id, mc.latest_source_run_id)
    JOIN repository_candidates c ON c.id = r.candidate_id JOIN sessions s ON s.id = mc.session_id AND s.ended_at IS NULL
    WHERE a.run_id = ? AND mc.status = 'resolving' AND r.status IN ('provisioning', 'running', 'checking')`)
    .bind(input.runId).first<{ caseId: string; sessionId: string; attempts: number; sourceRunId: string; candidateSha: string; sourceCommitSha: string; autoResolve: number; currentCandidateSha: string; remoteCandidateSha: string }>();
  if (!context) return null;
  if (context.candidateSha !== context.currentCandidateSha || context.candidateSha !== context.remoteCandidateSha) {
    await refreshConflictSnapshot(context.sessionId, context.caseId, input.runId, database);
    return null;
  }
  const provenance = await conflictProvenance(context.caseId, input.paths, database);
  const existing = await database.prepare("SELECT id FROM merge_conflict_snapshots WHERE run_id = ?").bind(input.runId).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const now = Date.now();
  const token = crypto.randomUUID();
  const result = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET mutation_id = ? WHERE id = ? AND current_resolver_run_id = ? AND status = 'resolving'
      AND EXISTS (SELECT 1 FROM agent_runs r JOIN sessions s ON s.id = r.session_id JOIN repository_candidates c ON c.id = r.candidate_id
        WHERE r.id = ? AND r.status IN ('provisioning', 'running', 'checking') AND s.ended_at IS NULL
          AND c.candidate_sha = r.candidate_sha AND c.remote_candidate_sha = r.candidate_sha AND c.status = 'active' AND c.merged_at IS NULL)`)
      .bind(token, context.caseId, input.runId, input.runId),
    database.prepare(`INSERT INTO merge_conflict_snapshots (id, case_id, run_id, source_run_id, candidate_sha, source_commit_sha, manifest_key, provenance, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)
      ON CONFLICT(run_id) DO NOTHING`).bind(id, context.caseId, input.runId, context.sourceRunId, context.candidateSha, context.sourceCommitSha, input.manifestKey, JSON.stringify(provenance), now, context.caseId, token),
    database.prepare(`UPDATE merge_conflict_cases SET snapshot_id = ?, proposal_id = NULL, revision = revision + 1, conflict_paths = ?, updated_at = ?
      WHERE id = ? AND mutation_id = ? AND (snapshot_id IS NULL OR snapshot_id != ?)`)
      .bind(id, JSON.stringify(input.paths), now, context.caseId, token, id),
    database.prepare(`UPDATE merge_conflict_attempts SET snapshot_id = ? WHERE run_id = ?
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(id, input.runId, context.caseId, token),
    bump(database, context.sessionId, context.caseId, token),
  ]);
  if (Number(result[0].meta?.changes ?? 0) !== 1) return null;
  return { ...context, snapshotId: id, provenance };
}

export async function finishConflictPreparation(runId: string, database = getDb()) {
  const context = await database.prepare(`SELECT mc.id AS caseId, mc.session_id AS sessionId, s.auto_resolve_conflicts AS autoResolve
    FROM merge_conflict_cases mc JOIN sessions s ON s.id = mc.session_id AND s.ended_at IS NULL
    JOIN agent_runs r ON r.id = mc.current_resolver_run_id AND r.status IN ('provisioning', 'running', 'checking')
    WHERE mc.current_resolver_run_id = ? AND mc.snapshot_id IS NOT NULL AND mc.status = 'resolving'`).bind(runId)
    .first<{ caseId: string; sessionId: string; autoResolve: number }>();
  if (!context) return null;
  const now = Date.now();
  const token = crypto.randomUUID();
  const result = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET status = ?, mode = 'ai', current_resolver_run_id = NULL, resume_requested = 0,
      waiting_reason = ?, revision = revision + 1, mutation_id = ?, updated_at = ? WHERE id = ? AND current_resolver_run_id = ? AND status = 'resolving'
      AND EXISTS (SELECT 1 FROM agent_runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND r.status IN ('provisioning', 'running', 'checking') AND s.ended_at IS NULL)`)
      .bind(context.autoResolve ? "pending" : "awaiting_input", context.autoResolve ? "Waiting for AI capacity." : "Automatic resolution is off. Propose a manual result or request AI assistance.", token, now, context.caseId, runId, runId),
    database.prepare(`UPDATE agent_runs SET status = 'ready', completion = 'no_changes', summary = 'Conflict versions are ready to inspect.', completed_at = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`)
      .bind(now, now, runId, context.caseId, token),
    database.prepare(`UPDATE floor_queue_items SET status = 'blocked', updated_at = ? WHERE id = (SELECT queue_item_id FROM agent_runs WHERE id = ?)
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(now, runId, context.caseId, token),
    bump(database, context.sessionId, context.caseId, token),
  ]);
  return Number(result[0].meta?.changes ?? 0) === 1 ? context : null;
}

export async function refreshConflictSnapshot(sessionId: string, caseId: string, runId: string | null, database = getDb(), revision: number | null = null) {
  const now = Date.now();
  const changed = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET snapshot_id = NULL, proposal_id = NULL, mode = 'prepare', status = 'pending', automatic_attempts = 0,
      resume_requested = 1, current_resolver_run_id = NULL, revision = revision + 1,
      waiting_reason = 'Candidate changed. Preparing current versions; previous decisions remain in history.', updated_at = ?
      WHERE id = ? AND session_id = ? AND status != 'resolved' AND (current_resolver_run_id IS NULL OR current_resolver_run_id = ?) AND (? IS NULL OR revision = ?)
      AND EXISTS (SELECT 1 FROM sessions WHERE id = session_id AND ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id = current_resolver_run_id AND status IN ('cancel_requested', 'cancelled'))`)
      .bind(now, caseId, sessionId, runId, revision, revision),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1 WHERE id = ? AND changes() = 1").bind(sessionId),
  ]);
  return Number(changed[0].meta?.changes ?? 0) === 1;
}

export async function recordConflictAssessment(runId: string, assessment: import("@/lib/conflict-resolution").ConflictAssessment, database = getDb()) {
  const context = await database.prepare(`SELECT mc.id AS caseId, mc.session_id AS sessionId, mc.snapshot_id AS snapshotId
    FROM merge_conflict_attempts a JOIN merge_conflict_cases mc ON mc.id = a.case_id AND mc.current_resolver_run_id = a.run_id
    JOIN agent_runs r ON r.id = a.run_id
    WHERE a.run_id = ? AND a.execution_mode = 'ai' AND mc.status = 'resolving' AND r.status = 'running'
      AND mc.snapshot_id = a.snapshot_id`).bind(runId).first<{ caseId: string; sessionId: string; snapshotId: string }>();
  if (!context) return null;
  const resolution = (await getConflictResolutionViews(context.sessionId, database)).get(context.caseId);
  if (!resolution) return null;
  if (assessment.outcome === "compatible" && !resolution.proposal?.approved) {
    const prompts = [...resolution.provenance.incoming, ...resolution.provenance.integrated];
    if (resolution.provenance.requiresOwner || JSON.stringify(resolution.provenance).length > 64_000
      || prompts.some((prompt) => !assessment.preservedPromptIds.includes(prompt.id))) return null;
  }
  const updated = await database.prepare(`UPDATE merge_conflict_attempts SET assessment = ? WHERE run_id = ?
    AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE current_resolver_run_id = ? AND status = 'resolving' AND snapshot_id = ?)`)
    .bind(JSON.stringify(assessment), runId, runId, context.snapshotId).run();
  return Number(updated.meta?.changes ?? 0) === 1 ? context : null;
}

/** Rechecked before every credential-bearing publication and integration attempt. */
export async function conflictExecutionAuthorized(runId: string, database = getDb()) {
  const row = await database.prepare(`SELECT mc.id AS caseId, mc.session_id AS sessionId, a.proposal_id AS proposalId, a.assessment
    FROM merge_conflict_attempts a JOIN merge_conflict_cases mc ON mc.current_resolver_run_id = a.run_id AND mc.id = a.case_id
    JOIN merge_conflict_snapshots sn ON sn.id = mc.snapshot_id AND sn.id = a.snapshot_id
    JOIN agent_runs r ON r.id = a.run_id JOIN agent_runs source ON source.id = a.source_run_id
    JOIN repository_candidates c ON c.id = r.candidate_id JOIN repository_connections rc ON rc.id = c.connection_id
    JOIN sessions s ON s.id = mc.session_id AND s.ended_at IS NULL
    WHERE a.run_id = ? AND mc.status = 'resolving' AND r.status IN ('running', 'checking', 'ready', 'publishing', 'published', 'integrating')
      AND NOT EXISTS (SELECT 1 FROM agent_run_checks checks WHERE checks.run_id = r.id AND checks.status != 'passed')
      AND a.execution_mode != 'prepare' AND c.status = 'active' AND c.merged_at IS NULL AND rc.status = 'ready'
      AND sn.source_commit_sha = source.local_commit_sha AND sn.source_run_id = source.id
      AND sn.candidate_sha = r.candidate_sha AND c.candidate_sha = sn.candidate_sha AND c.remote_candidate_sha = sn.candidate_sha
      AND (a.proposal_id = mc.proposal_id OR a.proposal_id IS NULL AND mc.proposal_id IS NULL)`)
    .bind(runId).first<{ caseId: string; sessionId: string; proposalId: string | null; assessment: string | null }>();
  if (!row) return false;
  const view = (await getConflictResolutionViews(row.sessionId, database)).get(row.caseId);
  if (!view) return false;
  if (row.proposalId) return view.proposal?.id === row.proposalId && view.proposal.approved;
  if (!row.assessment) return false;
  const assessment = JSON.parse(row.assessment) as import("@/lib/conflict-resolution").ConflictAssessment;
  return assessment.outcome === "compatible" && !view.provenance.requiresOwner
    && [...view.provenance.incoming, ...view.provenance.integrated].every((prompt) => assessment.preservedPromptIds.includes(prompt.id));
}

export async function setConflictWaitingReason(caseId: string, reason: string, database = getDb()) {
  const result = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET waiting_reason = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND current_resolver_run_id IS NULL AND status IN ('pending', 'failed') AND COALESCE(waiting_reason, '') != ?`)
      .bind(reason.slice(0, 2000), Date.now(), caseId, reason.slice(0, 2000)),
    database.prepare(`UPDATE sessions SET floor_revision = floor_revision + 1
      WHERE id = (SELECT session_id FROM merge_conflict_cases WHERE id = ?) AND changes() = 1`).bind(caseId),
  ]);
  if (Number(result[0].meta?.changes ?? 0) !== 1) return null;
  return database.prepare(`SELECT s.id AS sessionId, s.floor_revision AS revision FROM sessions s JOIN merge_conflict_cases mc ON mc.session_id = s.id WHERE mc.id = ?`)
    .bind(caseId).first<{ sessionId: string; revision: number }>();
}

export async function finishConflictWithoutChanges(runId: string, database = getDb()) {
  const context = await database.prepare(`SELECT mc.id AS caseId, mc.session_id AS sessionId, s.floor_revision AS floorRevision
    FROM merge_conflict_cases mc JOIN sessions s ON s.id = mc.session_id WHERE mc.current_resolver_run_id = ?`)
    .bind(runId).first<{ caseId: string; sessionId: string; floorRevision: number }>();
  if (!context || !await conflictExecutionAuthorized(runId, database)) return null;
  const now = Date.now(); const token = crypto.randomUUID();
  const result = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET status = 'resolved', resolved_at = ?, updated_at = ?, mutation_id = ?, revision = revision + 1,
      waiting_reason = NULL, failure_reason = NULL WHERE id = ? AND current_resolver_run_id = ? AND status = 'resolving'
      AND EXISTS (SELECT 1 FROM agent_runs r JOIN repository_candidates c ON c.id = r.candidate_id JOIN sessions s ON s.id = r.session_id
        WHERE r.id = ? AND r.status = 'checking' AND s.ended_at IS NULL AND s.floor_revision = ? AND c.status = 'active' AND c.merged_at IS NULL
          AND c.candidate_sha = r.candidate_sha AND c.remote_candidate_sha = r.candidate_sha)`)
      .bind(now, now, token, context.caseId, runId, runId, context.floorRevision),
    database.prepare(`UPDATE agent_runs SET status = 'ready', completion = 'no_changes', run_branch = NULL,
      summary = 'The current candidate already matches the approved resolution; no Git change is needed.', completed_at = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(now, now, runId, context.caseId, token),
    database.prepare(`UPDATE floor_queue_items SET status = 'completed', updated_at = ? WHERE id = (SELECT queue_item_id FROM agent_runs WHERE id = ?)
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(now, runId, context.caseId, token),
    bump(database, context.sessionId, context.caseId, token),
  ]);
  if (Number(result[0].meta?.changes ?? 0) !== 1) return null;
  return database.prepare("SELECT id AS sessionId, floor_revision AS revision FROM sessions WHERE id = ?").bind(context.sessionId).first<{ sessionId: string; revision: number }>();
}

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POST as postConflictInput } from "@/app/runtime/run/conflict-input/route";
import { createFloorAgent, createFloorQueueItem, getFloorSnapshot } from "@/db/floor";
import {
  advanceConflictAfterFailure,
  finishResolverAwaitingInput,
  createConflictResolverRun,
  getMergeConflictCases,
  recordIntegrationConflict,
  requestConflictInput,
  requestConflictResolution,
  markConflictResolved,
} from "@/db/conflicts";
import { getConflictDecisionView, proposeConflictResolution, voteConflictProposal, recordPreparedConflict, finishConflictPreparation, refreshConflictSnapshot, recordConflictAssessment, finishConflictWithoutChanges } from "@/db/conflict-decisions";
import { runRoutingTick } from "@/db/routing";
import { getRunGatewayContext } from "@/db/runs";
import { acceptInvite, createSession, endSession, SessionEndedError, setSessionRoutingSettings, upsertUser } from "@/db/sessions";
import { signRunGatewayToken, type RunGatewayClaims } from "@/lib/runtime-token";
import { parseAgentInput } from "@/lib/validation";

const SECRET = "worker-test-runtime-gateway-secret";

function identity(id: string, name: string) {
  return { providerUserId: `conflict-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function seed(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const unrelated = await upsertUser(identity(`${suffix}-unrelated`, "Unrelated Member"), env.DB);
  const outsider = await upsertUser(identity(`${suffix}-outsider`, "Outsider Example"), env.DB);
  const created = await createSession(owner.id, { title: `Conflict ${suffix}`, objective: "Preserve both changes" }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  await acceptInvite(created.inviteId, unrelated.id, env.DB);
  const input = parseAgentInput({ name: "Lumen", role: "Engineer", task: "Own integration", ownerUserId: member.id });
  if (!input) throw new Error("Invalid agent fixture");
  const withAgent = await createFloorAgent(created.session.id, member.id, input, env.DB);
  const agentId = withAgent!.agents[0].id;
  const withQueue = await createFloorQueueItem(created.session.id, member.id, { prompt: "Change shared files", agentId }, env.DB);
  const queueItemId = withQueue!.queue[0].id;
  const now = Date.now();
  const connectionId = crypto.randomUUID();
  const candidateId = crypto.randomUUID();
  const sha = "a".repeat(40);
  await env.DB.prepare(
    `INSERT INTO repository_connections
      (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name,
       repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
     VALUES (?, ?, 'inst', 'repo', 'node', 'owner', 'repo', 'owner/repo', 1, 'main', 'main', 'ready', ?, ?, ?)`,
  ).bind(connectionId, created.session.id, owner.id, now, now).run();
  await env.DB.prepare(
    `INSERT INTO repository_candidates
      (id, session_id, connection_id, name, description, branch_name, base_branch, base_sha, candidate_sha,
       remote_base_sha, remote_candidate_sha, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'Candidate', '', 'openfloor/candidate', 'main', ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).bind(candidateId, created.session.id, connectionId, sha, sha, sha, sha, owner.id, now, now).run();
  const sourceRunId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs
      (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, run_branch, bundle_key,
       local_commit_sha, run_commit_sha, remote_run_sha, attempt, status, model, sandbox_id, summary,
       conflict_reason, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'openfloor/run/source', ?, ?, ?, ?, 1, 'conflicted', 'gpt-test', 'sandbox',
       'Source summary', 'GitHub merge conflict', ?, ?, ?)`,
  ).bind(sourceRunId, created.session.id, queueItemId, agentId, candidateId, sha, `runs/${sourceRunId}/result.bundle`,
    "b".repeat(40), "c".repeat(40), "c".repeat(40), owner.id, now, now).run();
  await env.DB.prepare(
    `INSERT INTO agent_run_files (id, run_id, path, change_kind, additions, deletions, summary, diff_preview, created_at)
     VALUES (?, ?, 'src/shared.ts', 'update', 1, 1, 'Changed shared file', '', ?)`,
  ).bind(crypto.randomUUID(), sourceRunId, now).run();
  await env.DB.prepare("UPDATE floor_queue_items SET status = 'blocked' WHERE id = ?").bind(queueItemId).run();
  const recorded = await recordIntegrationConflict(sourceRunId, "GitHub merge conflict", env.DB);
  if (!recorded) throw new Error("Conflict case was not recorded");
  return { sessionId: created.session.id, owner, member, unrelated, outsider, agentId, queueItemId, sourceRunId, candidateId, caseId: recorded.caseId };
}

async function prepared(suffix: string, twoAuthors = false) {
  const room = await seed(suffix);
  if (twoAuthors) {
    const queue = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Already integrated feature", agentId: room.agentId }, env.DB);
    const queueId = queue!.queue.find((item) => item.prompts.some((prompt) => prompt.text === "Already integrated feature"))!.id;
    const runId = crypto.randomUUID(); const now = Date.now();
    await env.DB.prepare(`INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at, integrated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'integrated', 'gpt-test', 'history', ?, ?, ?, ?)`)
      .bind(runId, room.sessionId, queueId, room.agentId, room.candidateId, "a".repeat(40), room.owner.id, now, now, now).run();
    await env.DB.prepare(`INSERT INTO agent_run_files (id, run_id, path, change_kind, additions, deletions, diff_preview, created_at) VALUES (?, ?, 'src/shared.ts', 'update', 1, 1, '', ?)`)
      .bind(crypto.randomUUID(), runId, now).run();
  }
  const preparation = (await createConflictResolverRun(room.caseId, "automatic", env.DB))!;
  await recordPreparedConflict({ runId: preparation.runId, manifestKey: `conflicts/${room.caseId}/${preparation.runId}/v2/manifest.json`, paths: ["src/shared.ts"] }, env.DB);
  await finishConflictPreparation(preparation.runId, env.DB);
  return { ...room, preparationRunId: preparation.runId };
}

async function conflictInputToken(runId: string, overrides: Partial<RunGatewayClaims> = {}) {
  const context = await getRunGatewayContext(runId);
  if (!context) throw new Error("Missing resolver gateway context");
  return signRunGatewayToken({
    runId,
    sessionId: context.sessionId,
    repositoryId: context.repositoryId,
    candidateSha: context.candidateSha,
    operation: "conflict_input",
    ...overrides,
  }, SECRET);
}

function postConflictInputRequest(token: string, body: unknown, headers: Record<string, string> = {}) {
  return postConflictInput(new Request("http://localhost/runtime/run/conflict-input", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  }));
}

describe("durable merge conflicts", () => {
  it("releases waiting execution atomically, once, without overriding cancellation", async () => {
    const room = await prepared("waiting-finalization", true);
    const resolver = (await createConflictResolverRun(room.caseId, "automatic", env.DB))!;
    await env.DB.prepare("UPDATE agent_runs SET status = 'running' WHERE id = ?").bind(resolver.runId).run();
    await requestConflictInput(resolver.runId, "These outcomes contradict each other.", [], env.DB);
    const before = (await getFloorSnapshot(room.sessionId, room.owner.id, env.DB))!;
    await finishResolverAwaitingInput(resolver.runId, env.DB);
    const after = (await getFloorSnapshot(room.sessionId, room.owner.id, env.DB))!;
    expect(after.revision).toBe(before.revision + 1);
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0].currentResolverRunId).toBeNull();
    await finishResolverAwaitingInput(resolver.runId, env.DB);
    expect((await getFloorSnapshot(room.sessionId, room.owner.id, env.DB))!.revision).toBe(after.revision);
    const cancelledRoom = await prepared("waiting-cancelled", true);
    const cancelled = (await createConflictResolverRun(cancelledRoom.caseId, "automatic", env.DB))!;
    await requestConflictInput(cancelled.runId, "Choose an outcome.", [], env.DB);
    await env.DB.prepare("UPDATE agent_runs SET status = 'cancel_requested' WHERE id = ?").bind(cancelled.runId).run();
    const cancelledBefore = (await getFloorSnapshot(cancelledRoom.sessionId, cancelledRoom.owner.id, env.DB))!;
    await finishResolverAwaitingInput(cancelled.runId, env.DB);
    expect((await getFloorSnapshot(cancelledRoom.sessionId, cancelledRoom.owner.id, env.DB))!.revision).toBe(cancelledBefore.revision);
    expect(await env.DB.prepare("SELECT status FROM agent_runs WHERE id = ?").bind(cancelled.runId).first()).toEqual({ status: "cancel_requested" });
  });

  it("defaults automation on, records one idempotent case, and preserves omitted routing settings", async () => {
    const room = await seed("defaults");
    const floor = await getFloorSnapshot(room.sessionId, room.member.id, env.DB);
    expect(floor?.autoResolveConflicts).toBe(true);
    expect(floor?.review?.conflicts).toEqual([expect.objectContaining({ id: room.caseId, status: "pending", sourceRunId: room.sourceRunId })]);
    await recordIntegrationConflict(room.sourceRunId, "same delivery", env.DB);
    expect(await getMergeConflictCases(room.sessionId, env.DB)).toHaveLength(1);
    await setSessionRoutingSettings(room.sessionId, room.owner.id, { autoResolveConflicts: false }, env.DB);
    const row = await env.DB.prepare("SELECT auto_dispatch AS autoDispatch, auto_resolve_conflicts AS autoResolve FROM sessions WHERE id = ?")
      .bind(room.sessionId).first<{ autoDispatch: number; autoResolve: number }>();
    // auto_dispatch now defaults to 1 for every new session (db/sessions.ts
    // createSession) — this assertion is really about the omitted setting
    // being *preserved*, not about the value being 0.
    expect(row).toEqual({ autoDispatch: 1, autoResolve: 0 });
  });

  it("prepares without AI, requires both authors, and rejected concurrent writes leave no side effects", async () => {
    const room = await prepared("consensus", true);
    const initial = (await getConflictDecisionView(room.sessionId, room.caseId, room.member.id, env.DB))!.resolution;
    const input = { sessionId: room.sessionId, caseId: room.caseId, userId: room.member.id, revision: initial.revision, snapshotId: initial.snapshotId!, payload: { kind: "intent" as const, instruction: "Preserve both features behind separate entry points." } };
    expect(await proposeConflictResolution({ ...input, userId: room.unrelated.id }, env.DB)).toBe("missing");
    const raced = await Promise.all([proposeConflictResolution(input, env.DB), proposeConflictResolution({ ...input, payload: { kind: "intent", instruction: "Different proposal" } }, env.DB)]);
    expect(raced.sort()).toEqual(["recorded", "stale"]);
    let view = (await getConflictDecisionView(room.sessionId, room.caseId, room.owner.id, env.DB))!.resolution;
    expect(view.proposal?.approved).toBe(false);
    expect(view.proposal?.requiredAuthorIds.sort()).toEqual([room.owner.id, room.member.id].sort());
    const before = await env.DB.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(room.sessionId).first();
    expect(await proposeConflictResolution(input, env.DB)).toBe("stale");
    expect(await env.DB.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(room.sessionId).first()).toEqual(before);
    expect(await voteConflictProposal({ sessionId: room.sessionId, caseId: room.caseId, userId: room.owner.id, revision: view.revision, proposalId: view.proposal!.id, action: "approve" }, env.DB)).toBe("recorded");
    view = (await getConflictDecisionView(room.sessionId, room.caseId, room.member.id, env.DB))!.resolution;
    expect(view.proposal?.approved).toBe(true);
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0].status).toBe("pending");
  });

  it("records disagreement and requires a reasoned owner override for departed authors", async () => {
    const room = await prepared("override", true);
    let view = (await getConflictDecisionView(room.sessionId, room.caseId, room.member.id, env.DB))!.resolution;
    await proposeConflictResolution({ sessionId: room.sessionId, caseId: room.caseId, userId: room.member.id, revision: view.revision, snapshotId: view.snapshotId!, payload: { kind: "manual", selections: [{ path: "src/shared.ts", hunkIndex: -1, choice: "ours" }] } }, env.DB);
    view = (await getConflictDecisionView(room.sessionId, room.caseId, room.owner.id, env.DB))!.resolution;
    await voteConflictProposal({ sessionId: room.sessionId, caseId: room.caseId, userId: room.owner.id, revision: view.revision, proposalId: view.proposal!.id, action: "reject" }, env.DB);
    await env.DB.prepare("UPDATE session_members SET removed_at = ? WHERE session_id = ? AND user_id = ?").bind(Date.now(), room.sessionId, room.member.id).run();
    view = (await getConflictDecisionView(room.sessionId, room.caseId, room.owner.id, env.DB))!.resolution;
    expect(view.proposal).toMatchObject({ approved: false, requiresOwner: true });
    expect(await voteConflictProposal({ sessionId: room.sessionId, caseId: room.caseId, userId: room.owner.id, revision: view.revision, proposalId: view.proposal!.id, action: "override", reason: "The departed author agreed to preserve the shipping API in team review." }, env.DB)).toBe("recorded");
    expect((await getConflictDecisionView(room.sessionId, room.caseId, room.owner.id, env.DB))!.resolution.proposal?.approved).toBe(true);
  });

  it("invalidates candidate-bound proposals and ignores stale workflow completion", async () => {
    const room = await prepared("stale", true);
    const view = (await getConflictDecisionView(room.sessionId, room.caseId, room.member.id, env.DB))!.resolution;
    await env.DB.prepare("UPDATE repository_candidates SET candidate_sha = ?, remote_candidate_sha = ? WHERE id = ?").bind("d".repeat(40), "d".repeat(40), room.candidateId).run();
    expect(await proposeConflictResolution({ sessionId: room.sessionId, caseId: room.caseId, userId: room.member.id, revision: view.revision, snapshotId: view.snapshotId!, payload: { kind: "intent", instruction: "Old choice" } }, env.DB)).toBe("stale");
    await refreshConflictSnapshot(room.sessionId, room.caseId, null, env.DB, view.revision);
    await markConflictResolved(room.preparationRunId, "a".repeat(40), env.DB);
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0]).toMatchObject({ status: "pending", resolution: { snapshotId: null, proposal: null, mode: "prepare" } });
    const other = await seed("cross-session-owner");
    expect(await getConflictDecisionView(other.sessionId, room.caseId, other.owner.id, env.DB)).toBeNull();
  });

  it("binds runtime conflict input to the resolver and caps the request body", async () => {
    const acceptedRoom = await prepared("runtime-input-accepted");
    const acceptedResolver = await createConflictResolverRun(acceptedRoom.caseId, "automatic", env.DB);
    const acceptedToken = await conflictInputToken(acceptedResolver!.runId);
    const accepted = await postConflictInputRequest(acceptedToken, {
      explanation: "Need an API compatibility decision.",
      questions: ["Keep the existing response shape?"],
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true, caseId: acceptedRoom.caseId });
    expect((await getMergeConflictCases(acceptedRoom.sessionId, env.DB))[0]).toEqual(expect.objectContaining({ status: "awaiting_input" }));

    const rejectedRoom = await prepared("runtime-input-rejected");
    const rejectedResolver = await createConflictResolverRun(rejectedRoom.caseId, "automatic", env.DB);
    const payload = { explanation: "Need guidance.", questions: ["Which behavior wins?"] };
    const wrongOperation = await conflictInputToken(rejectedResolver!.runId, { operation: "events" });
    expect((await postConflictInputRequest(wrongOperation, payload)).status).toBe(404);
    const wrongCandidate = await conflictInputToken(rejectedResolver!.runId, { candidateSha: "wrong-candidate" });
    expect((await postConflictInputRequest(wrongCandidate, payload)).status).toBe(404);
    const wrongSession = await conflictInputToken(rejectedResolver!.runId, { sessionId: acceptedRoom.sessionId });
    expect((await postConflictInputRequest(wrongSession, payload)).status).toBe(404);
    expect((await postConflictInputRequest(await conflictInputToken(rejectedResolver!.runId), {
      explanation: "x".repeat(257 * 1024),
      questions: ["Too large?"],
    })).status).toBe(400);
  });

  it("allows two AI attempts per decision and version-bound author retry", async () => {
    const room = await prepared("budget");
    const first = await createConflictResolverRun(room.caseId, "automatic", env.DB);
    expect(first).not.toBeNull();
    await env.DB.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").bind(first!.runId).run();
    await advanceConflictAfterFailure(first!.runId, "first failed", env.DB);
    const second = await createConflictResolverRun(room.caseId, "automatic", env.DB);
    expect(second).not.toBeNull();
    await env.DB.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").bind(second!.runId).run();
    await advanceConflictAfterFailure(second!.runId, "second failed", env.DB);
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0]).toEqual(expect.objectContaining({ status: "failed", automaticAttempts: 2 }));
    const version = (await getConflictDecisionView(room.sessionId, room.caseId, room.member.id, env.DB))!.resolution.revision;
    await expect(requestConflictResolution(room.sessionId, room.caseId, room.member.id, env.DB)).resolves.toBe(false);
    await expect(requestConflictResolution(room.sessionId, room.caseId, room.member.id, env.DB, version)).resolves.toBe(false);
    await refreshConflictSnapshot(room.sessionId, room.caseId, null, env.DB, version);
    const manual = await createConflictResolverRun(room.caseId, "manual", env.DB);
    expect(manual).not.toBeNull();
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0].automaticAttempts).toBe(0);
  });

  it("does not replenish an exhausted proposal when authors repeat their approval", async () => {
    const room = await prepared("repeat-approval", true);
    let view = (await getConflictDecisionView(room.sessionId, room.caseId, room.member.id, env.DB))!.resolution;
    await proposeConflictResolution({ sessionId: room.sessionId, caseId: room.caseId, userId: room.member.id,
      revision: view.revision, snapshotId: view.snapshotId!, payload: { kind: "intent", instruction: "Preserve both entry points." } }, env.DB);
    view = (await getConflictDecisionView(room.sessionId, room.caseId, room.owner.id, env.DB))!.resolution;
    await voteConflictProposal({ sessionId: room.sessionId, caseId: room.caseId, userId: room.owner.id,
      revision: view.revision, proposalId: view.proposal!.id, action: "approve" }, env.DB);
    for (let index = 0; index < 2; index++) {
      const resolver = (await createConflictResolverRun(room.caseId, "manual", env.DB))!;
      expect(resolver).not.toBeNull();
      await env.DB.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").bind(resolver.runId).run();
      await advanceConflictAfterFailure(resolver.runId, "Required check failed.", env.DB);
    }
    view = (await getConflictDecisionView(room.sessionId, room.caseId, room.owner.id, env.DB))!.resolution;
    await voteConflictProposal({ sessionId: room.sessionId, caseId: room.caseId, userId: room.owner.id,
      revision: view.revision, proposalId: view.proposal!.id, action: "approve" }, env.DB);
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0]).toMatchObject({ status: "failed", automaticAttempts: 2 });
    expect(await createConflictResolverRun(room.caseId, "manual", env.DB)).toBeNull();
  });

  it("does not relaunch a resolver after explicit cancellation", async () => {
    const room = await prepared("cancelled");
    const resolver = await createConflictResolverRun(room.caseId, "automatic", env.DB);
    expect(resolver).not.toBeNull();
    await env.DB.prepare("UPDATE agent_runs SET status = 'cancelled' WHERE id = ?").bind(resolver!.runId).run();
    await expect(advanceConflictAfterFailure(resolver!.runId, "Cancelled by owner", env.DB, false))
      .resolves.toEqual({ sessionId: room.sessionId, retry: false });
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0]).toEqual(expect.objectContaining({
      status: "failed",
      automaticAttempts: 1,
      failureReason: "Cancelled by owner",
    }));
  });

  it("requires complete AI evidence and completes an explicitly justified no-change result", async () => {
    const room = await prepared("no-change", true);
    const resolver = (await createConflictResolverRun(room.caseId, "automatic", env.DB))!;
    await env.DB.prepare("UPDATE agent_runs SET status = 'running' WHERE id = ?").bind(resolver.runId).run();
    const view = (await getConflictDecisionView(room.sessionId, room.caseId, room.member.id, env.DB))!.resolution;
    const report = { outcome: "compatible" as const, explanation: "The candidate already contains both requested entry points.", evidence: ["Both behaviors exist in the current file."], preservedPromptIds: view.provenance.incoming.map((prompt) => prompt.id) };
    expect(await recordConflictAssessment(resolver.runId, report, env.DB)).toBeNull();
    report.preservedPromptIds.push(...view.provenance.integrated.map((prompt) => prompt.id));
    expect(await recordConflictAssessment(resolver.runId, report, env.DB)).not.toBeNull();
    await env.DB.prepare("UPDATE agent_runs SET status = 'checking' WHERE id = ?").bind(resolver.runId).run();
    await env.DB.prepare(`INSERT INTO agent_run_checks (id, run_id, position, command, status, updated_at) VALUES (?, ?, 0, 'npm test', 'pending', 1)`)
      .bind(crypto.randomUUID(), resolver.runId).run();
    expect(await finishConflictWithoutChanges(resolver.runId, env.DB)).toBeNull();
    await env.DB.prepare("UPDATE agent_run_checks SET status = 'passed' WHERE run_id = ?").bind(resolver.runId).run();
    expect(await finishConflictWithoutChanges(resolver.runId, env.DB)).not.toBeNull();
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0]).toMatchObject({ status: "resolved" });
    expect(await env.DB.prepare("SELECT status, completion, run_branch AS branch FROM agent_runs WHERE id = ?").bind(resolver.runId).first()).toEqual({ status: "ready", completion: "no_changes", branch: null });
    expect(await finishConflictWithoutChanges(resolver.runId, env.DB)).toBeNull();
  });

  it("copies recorded required checks only to execution attempts", async () => {
    const room = await prepared("checks");
    await env.DB.prepare(`INSERT INTO agent_run_checks (id, run_id, position, command, status, updated_at) VALUES (?, ?, 0, 'npm test', 'passed', ?)`)
      .bind(crypto.randomUUID(), room.sourceRunId, Date.now()).run();
    const resolver = (await createConflictResolverRun(room.caseId, "automatic", env.DB))!;
    expect(await env.DB.prepare("SELECT command, status FROM agent_run_checks WHERE run_id = ?").bind(resolver.runId).all()).toMatchObject({ results: [{ command: "npm test", status: "pending" }] });
    expect(await env.DB.prepare("SELECT command FROM agent_run_checks WHERE run_id = ?").bind(room.preparationRunId).all()).toMatchObject({ results: [] });
  });

  it("dispatches an eligible resolver before ordinary queued work even when auto-dispatch is off", async () => {
    const room = await seed("priority");
    const ordinary = await createFloorQueueItem(room.sessionId, room.owner.id, { prompt: "Ordinary work", agentId: room.agentId }, env.DB);
    const ordinaryId = ordinary!.queue.find((item) => item.status === "queued")!.id;
    const calls: string[] = [];
    const outcome = await runRoutingTick(room.sessionId, "alarm", {
      startConflictResolution: async (conflict) => { calls.push(`conflict:${conflict.id}`); return { ok: true, runId: "resolver" }; },
      startRun: async (_sessionId, itemId) => { calls.push(`ordinary:${itemId}`); return { ok: true, runId: "ordinary" }; },
      disabledProviders: new Set(),
    }, env.DB);
    expect(outcome.acted).toBe(true);
    expect(calls).toEqual([`conflict:${room.caseId}`]);
    expect(calls).not.toContain(`ordinary:${ordinaryId}`);
  });

  it("conceals cross-session cases and refuses conflict mutations after session end", async () => {
    const room = await seed("ended");
    const other = await seed("other");
    await expect(requestConflictResolution(room.sessionId, other.caseId, room.owner.id, env.DB)).resolves.toBeNull();
    await endSession(room.sessionId, room.owner.id, "owner", env.DB);
    await expect(requestConflictResolution(room.sessionId, room.caseId, room.owner.id, env.DB)).rejects.toBeInstanceOf(SessionEndedError);
  });
});

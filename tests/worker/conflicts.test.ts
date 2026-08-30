import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POST as postConflictInput } from "@/app/runtime/run/conflict-input/route";
import { createFloorAgent, createFloorQueueItem, getFloorSnapshot } from "@/db/floor";
import {
  advanceConflictAfterFailure,
  answerConflictQuestions,
  createConflictResolverRun,
  getMergeConflictCases,
  recordIntegrationConflict,
  requestConflictInput,
  requestConflictResolution,
} from "@/db/conflicts";
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
  return { sessionId: created.session.id, owner, member, unrelated, outsider, agentId, queueItemId, sourceRunId, caseId: recorded.caseId };
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

  it("accepts one complete member answer set, rejects stale races, and resets attempt budget", async () => {
    const room = await seed("answers");
    const resolver = await createConflictResolverRun(room.caseId, "automatic", env.DB);
    expect(resolver).not.toBeNull();
    const requested = await requestConflictInput(resolver!.runId, "Need API policy", ["Keep the old response shape?", "Deprecate now?"], env.DB);
    expect(requested?.caseId).toBe(room.caseId);
    const conflict = (await getMergeConflictCases(room.sessionId, env.DB))[0];
    const answers = conflict.questions.map((question, index) => ({ questionId: question.id, answer: index === 0 ? "Yes" : "No" }));
    await expect(answerConflictQuestions(room.sessionId, room.caseId, room.outsider.id, answers, env.DB)).resolves.toBe("missing");
    await expect(answerConflictQuestions(room.sessionId, room.caseId, room.unrelated.id, answers, env.DB)).resolves.toBe("missing");
    const raced = await Promise.all([
      answerConflictQuestions(room.sessionId, room.caseId, room.member.id, answers, env.DB),
      answerConflictQuestions(room.sessionId, room.caseId, room.owner.id, answers, env.DB),
    ]);
    expect(raced.sort()).toEqual(["answered", "stale"]);
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0]).toEqual(expect.objectContaining({ status: "pending", automaticAttempts: 0 }));
  });

  it("binds runtime conflict input to the resolver and caps the request body", async () => {
    const acceptedRoom = await seed("runtime-input-accepted");
    const acceptedResolver = await createConflictResolverRun(acceptedRoom.caseId, "automatic", env.DB);
    const acceptedToken = await conflictInputToken(acceptedResolver!.runId);
    const accepted = await postConflictInputRequest(acceptedToken, {
      explanation: "Need an API compatibility decision.",
      questions: ["Keep the existing response shape?"],
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true, caseId: acceptedRoom.caseId });
    expect((await getMergeConflictCases(acceptedRoom.sessionId, env.DB))[0]).toEqual(expect.objectContaining({ status: "awaiting_input" }));

    const rejectedRoom = await seed("runtime-input-rejected");
    const rejectedResolver = await createConflictResolverRun(rejectedRoom.caseId, "automatic", env.DB);
    const payload = { explanation: "Need guidance.", questions: ["Which behavior wins?"] };
    const wrongOperation = await conflictInputToken(rejectedResolver!.runId, { operation: "events" });
    expect((await postConflictInputRequest(wrongOperation, payload)).status).toBe(404);
    const wrongCandidate = await conflictInputToken(rejectedResolver!.runId, { candidateSha: "wrong-candidate" });
    expect((await postConflictInputRequest(wrongCandidate, payload)).status).toBe(404);
    const wrongSession = await conflictInputToken(rejectedResolver!.runId, { sessionId: acceptedRoom.sessionId });
    expect((await postConflictInputRequest(wrongSession, payload)).status).toBe(404);
    expect((await postConflictInputRequest(await conflictInputToken(rejectedResolver!.runId), {
      explanation: "x".repeat(17 * 1024),
      questions: ["Too large?"],
    })).status).toBe(413);
  });

  it("allows two automatic attempts after an answer budget and owner-only manual retry", async () => {
    const room = await seed("budget");
    const first = await createConflictResolverRun(room.caseId, "automatic", env.DB);
    expect(first).not.toBeNull();
    await env.DB.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").bind(first!.runId).run();
    await advanceConflictAfterFailure(first!.runId, "first failed", env.DB);
    const second = await createConflictResolverRun(room.caseId, "automatic", env.DB);
    expect(second).not.toBeNull();
    await env.DB.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").bind(second!.runId).run();
    await advanceConflictAfterFailure(second!.runId, "second failed", env.DB);
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0]).toEqual(expect.objectContaining({ status: "failed", automaticAttempts: 2 }));
    await expect(requestConflictResolution(room.sessionId, room.caseId, room.member.id, env.DB)).resolves.toBeNull();
    await expect(requestConflictResolution(room.sessionId, room.caseId, room.owner.id, env.DB)).resolves.toBe(true);
    const manual = await createConflictResolverRun(room.caseId, "manual", env.DB);
    expect(manual).not.toBeNull();
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0].automaticAttempts).toBe(2);
  });

  it("does not relaunch a resolver after explicit cancellation", async () => {
    const room = await seed("cancelled");
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

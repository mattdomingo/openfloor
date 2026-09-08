import { parseAgentInput } from "@/lib/validation";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acceptInvite, createSession, deleteAccount, upsertUser, updateProfile } from "@/db/sessions";
import { createFloorAgent, createFloorQueueItem, getFloorSnapshot } from "@/db/floor";
import { activateRepositoryCandidate, reserveRepositoryCandidate, saveRepositoryConnection } from "@/db/repositories";
import { createAgentRun, getAgentRun, getAgentRunHistoryForMember } from "@/db/runs";
import { getQueueRunAttribution, getCandidateCommitAuthors } from "@/db/run-attribution";
import { consumeGitHubAccountConnectionState, createGitHubAccountConnectionState, refreshUserGitHubInstallations } from "@/db/github-installations";

const proof = { id: "123", login: "engineer", verifiedAt: 1 };
async function room() {
  const key = crypto.randomUUID();
  const owner = await upsertUser({ providerUserId: key, email: `${key}@example.com`, displayName: "Dispatcher", fullName: "Dispatcher" }, env.DB);
  const member = await upsertUser({ providerUserId: `member-${key}`, email: `member-${key}@example.com`, displayName: "Engineer", fullName: "Engineer" }, env.DB);
  const created = await createSession(owner.id, { title: "Attribution", objective: null }, env.DB);
  const sessionId = created.session.id;
  await acceptInvite(created.inviteId, member.id, env.DB);
  const saved = await saveRepositoryConnection(sessionId, owner.id, null, "installation", {
    id: key, nodeId: "node", owner: "org", name: "repo", fullName: "org/repo", private: true, defaultBranch: "main",
  }, "main", env.DB);
  const candidateId = crypto.randomUUID();
  await reserveRepositoryCandidate(sessionId, owner.id, saved!.id, candidateId, "Attribution", "", `openfloor/${sessionId.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`, "main", "a".repeat(40), env.DB);
  await activateRepositoryCandidate(sessionId, candidateId, "a".repeat(40), env.DB);
  const floor = await createFloorAgent(sessionId, owner.id, parseAgentInput({ usageScope: "session", name: "Builder", role: "Engineer", task: "Build features" })!, env.DB);
  const queued = await createFloorQueueItem(sessionId, member.id, { prompt: "Add a feature", agentId: floor!.agents[0].id }, env.DB);
  return { owner, member, sessionId, candidateId, queueItemId: queued!.queue[0].id };
}

describe("engineer verification and run identity", () => {
  it("blocks unverified authors before any run exists; typed handles never establish proof", async () => {
    const r = await room();
    await updateProfile(r.member.id, { firstName: "Engineer", lastName: "Example", githubHandle: "claimed", avatarKey: undefined }, env.DB);
    await expect(createAgentRun(r.sessionId, r.queueItemId, r.owner.id, "task", env.DB)).rejects.toThrow("GitHub verification required");
    expect((await getFloorSnapshot(r.sessionId, r.member.id, env.DB))?.queue[0].status).toBe("queued");
    expect(await env.DB.prepare("SELECT id FROM agent_runs WHERE session_id = ?").bind(r.sessionId).first()).toBeNull();
    await expect(createAgentRun(r.sessionId, r.queueItemId, "outsider", "task", env.DB)).rejects.toThrow("Session not found");
    const reply = await createAgentRun(r.sessionId, r.queueItemId, r.owner.id, "reply", env.DB);
    expect(reply.kind).toBe("reply");
  });

  it("snapshots prompter identity instead of dispatcher or agent owner; future profile refresh cannot change it", async () => {
    const r = await room();
    await refreshUserGitHubInstallations(r.member.id, [], env.DB, proof);
    const run = await createAgentRun(r.sessionId, r.queueItemId, r.owner.id, "task", env.DB);
    const stored = await env.DB.prepare("SELECT attribution FROM agent_runs WHERE id = ?").bind(run.id).first<{ attribution: string }>();
    expect(JSON.parse(stored!.attribution)).toEqual({ kind: "human", authors: [{ userId: r.member.id, githubId: "123", login: "engineer" }] });
    expect(run.attribution?.authors[0].githubId).toBe("123");
    expect(run.promptedBy).toEqual([{ userId: r.member.id, name: "Engineer", deleted: false }]);
    await refreshUserGitHubInstallations(r.member.id, [], env.DB, { ...proof, login: "renamed" });
    expect(await env.DB.prepare("SELECT attribution FROM agent_runs WHERE id = ?").bind(run.id).first()).toEqual(stored);
    expect(await deleteAccount(r.member.id, env.DB)).toEqual({ deleted: true });
    expect(await env.DB.prepare("SELECT verified_github FROM users WHERE id = ?").bind(r.member.id).first()).toEqual({ verified_github: null });
    expect((await getAgentRun(run.id, env.DB))?.promptedBy).toEqual([{ userId: r.member.id, name: "Deleted user", deleted: true }]);
    expect(await env.DB.prepare("SELECT attribution FROM agent_runs WHERE id = ?").bind(run.id).first()).toEqual(stored);
  });

  it("requires every prompter, preserves chronological order, and deduplicates verified accounts", async () => {
    const r = await room();
    await env.DB.prepare("UPDATE floor_queue_prompts SET created_at = 1 WHERE queue_item_id = ?").bind(r.queueItemId).run();
    await env.DB.prepare("INSERT INTO floor_queue_prompts (id, queue_item_id, author_user_id, text, created_at) VALUES (?, ?, ?, 'Also update docs', 2)").bind(crypto.randomUUID(), r.queueItemId, r.owner.id).run();
    await refreshUserGitHubInstallations(r.member.id, [], env.DB, proof);
    await expect(getQueueRunAttribution(r.sessionId, r.queueItemId, true, env.DB)).rejects.toThrow("Dispatcher");
    await refreshUserGitHubInstallations(r.owner.id, [], env.DB, { ...proof, id: "456", login: "second" });
    expect((await getQueueRunAttribution(r.sessionId, r.queueItemId, true, env.DB)).authors.map((a) => a.login)).toEqual(["engineer", "second"]);
    await refreshUserGitHubInstallations(r.owner.id, [], env.DB, proof);
    expect((await getQueueRunAttribution(r.sessionId, r.queueItemId, true, env.DB)).authors).toHaveLength(1);
    await env.DB.prepare("UPDATE floor_queue_items SET origin = 'ci_failure' WHERE id = ?").bind(r.queueItemId).run();
    expect(await getQueueRunAttribution(r.sessionId, r.queueItemId, true, env.DB)).toEqual({ kind: "system", authors: [] });
  });

  it("binds callback identity to one-use state and preserves it on replay or invalid input", async () => {
    const r = await room();
    const state = await createGitHubAccountConnectionState(r.member.id, "settings", "/home", env.DB);
    expect(await consumeGitHubAccountConnectionState(state, r.owner.id, "1", { login: "org", type: "Organization" }, ["repo"], env.DB, proof)).toBeNull();
    expect(await consumeGitHubAccountConnectionState(state, r.member.id, "1", { login: "org", type: "Organization" }, ["repo"], env.DB, proof)).not.toBeNull();
    expect(await consumeGitHubAccountConnectionState(state, r.member.id, "1", { login: "org", type: "Organization" }, ["repo"], env.DB, { ...proof, login: "attacker" })).toBeNull();
    const user = await env.DB.prepare("SELECT verified_github AS identity FROM users WHERE id = ?").bind(r.member.id).first<{ identity: string }>();
    expect(JSON.parse(user!.identity)).toEqual(proof);
    await expect(refreshUserGitHubInstallations(r.member.id, [], env.DB, { ...proof, login: "evil\ntrailer" })).rejects.toThrow("Invalid verified");
  });
  it("credits the whole active candidate beyond 20 runs, excluding removed work, system feedback and noncontributors", async () => {
    const r = await room();
    await refreshUserGitHubInstallations(r.member.id, [], env.DB, proof);
    const run = await createAgentRun(r.sessionId, r.queueItemId, r.owner.id, "task", env.DB);
    await env.DB.prepare("UPDATE agent_runs SET status = 'integrated', integrated_at = 1 WHERE id = ?").bind(run.id).run();
    await env.DB.prepare("INSERT INTO agent_run_files (id, run_id, path, change_kind, additions, deletions, diff_preview, created_at) VALUES (?, ?, 'file.ts', 'add', 1, 0, '+hello', 1)").bind(crypto.randomUUID(), run.id).run();
    for (let i = 0; i < 22; i++) {
      await env.DB.prepare(`INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at)
        SELECT ?, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, ?, 'failed', model, sandbox_id, created_by, created_at + ?, updated_at FROM agent_runs WHERE id = ?`)
        .bind(crypto.randomUUID(), i + 2, i + 1, run.id).run();
    }
    await env.DB.prepare("UPDATE session_members SET removed_at = 1 WHERE session_id = ? AND user_id = ?").bind(r.sessionId, r.member.id).run();
    expect((await getAgentRunHistoryForMember(r.sessionId, r.owner.id, null, env.DB))?.runs).toHaveLength(20);
    expect(await getCandidateCommitAuthors(r.sessionId, r.candidateId, env.DB)).toEqual([{ userId: r.member.id, githubId: "123", login: "engineer" }]);
    expect(await getCandidateCommitAuthors("another-session", r.candidateId, env.DB)).toEqual([]);
    await env.DB.prepare("UPDATE agent_runs SET attribution = NULL WHERE id = ?").bind(run.id).run();
    expect((await getAgentRun(run.id, env.DB))?.attribution).toBeNull();
    expect((await getCandidateCommitAuthors(r.sessionId, r.candidateId, env.DB))[0].githubId).toBe("123");
    await env.DB.prepare("INSERT INTO agent_run_rollbacks (id, run_id, session_id, candidate_id, status, expected_candidate_sha, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, 1, 1)").bind(crypto.randomUUID(), run.id, r.sessionId, r.candidateId, "a".repeat(40), r.owner.id).run();
    expect(await getCandidateCommitAuthors(r.sessionId, r.candidateId, env.DB)).toEqual([]);
  });

  it("applies the additive migration to populated legacy tables without cascading away authored work", async () => {
    const r = await room();
    await refreshUserGitHubInstallations(r.member.id, [], env.DB, proof);
    const run = await createAgentRun(r.sessionId, r.queueItemId, r.owner.id, "task", env.DB);
    const before = await env.DB.prepare("SELECT id, session_id, agent_id, queue_item_id FROM agent_runs WHERE id = ?").bind(run.id).first();
    await env.DB.prepare("ALTER TABLE agent_runs DROP COLUMN attribution").run();
    await env.DB.prepare("ALTER TABLE users DROP COLUMN verified_github").run();
    const queries = JSON.parse(env.ATTRIBUTION_MIGRATION_QUERIES) as string[];
    await env.DB.batch(queries.map((sql) => env.DB.prepare(sql)));
    expect(await env.DB.prepare("SELECT id, session_id, agent_id, queue_item_id FROM agent_runs WHERE id = ?").bind(run.id).first()).toEqual(before);
    expect((await getFloorSnapshot(r.sessionId, r.member.id, env.DB))?.queue[0].prompts[0].authorUserId).toBe(r.member.id);
    expect((await getAgentRun(run.id, env.DB))?.attribution).toBeNull();
  });

});

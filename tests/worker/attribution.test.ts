import { parseAgentInput } from "@/lib/validation";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acceptInvite, createSession, upsertUser, updateProfile } from "@/db/sessions";
import { createFloorAgent, createFloorQueueItem, getFloorSnapshot } from "@/db/floor";
import { activateRepositoryCandidate, reserveRepositoryCandidate, saveRepositoryConnection } from "@/db/repositories";
import { createAgentRun } from "@/db/runs";
import { getQueueRunAttribution } from "@/db/run-attribution";
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
  const floor = await createFloorAgent(sessionId, owner.id, parseAgentInput({ name: "Builder", role: "Engineer", task: "Build features" })!, env.DB);
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
    await expect(createAgentRun(r.sessionId, r.queueItemId, r.member.id, "task", env.DB)).rejects.toThrow("Session not found");
    const reply = await createAgentRun(r.sessionId, r.queueItemId, r.owner.id, "reply", env.DB);
    expect(reply.kind).toBe("reply");
  });

  it("snapshots prompter identity instead of dispatcher or agent owner; future profile refresh cannot change it", async () => {
    const r = await room();
    await refreshUserGitHubInstallations(r.member.id, [], env.DB, proof);
    const run = await createAgentRun(r.sessionId, r.queueItemId, r.owner.id, "task", env.DB);
    const stored = await env.DB.prepare("SELECT attribution FROM agent_runs WHERE id = ?").bind(run.id).first<{ attribution: string }>();
    expect(JSON.parse(stored!.attribution)).toEqual({ kind: "human", authors: [{ userId: r.member.id, githubId: "123", login: "engineer" }] });
    await refreshUserGitHubInstallations(r.member.id, [], env.DB, { ...proof, login: "renamed" });
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
});

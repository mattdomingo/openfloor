import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  createSession,
  getActiveInviteId,
  getInvitePreview,
  getSessionMembers,
  leaveSession,
  listSessionsForUser,
  revokeInvite,
  rotateInvite,
  updateSessionObjective,
  upsertUser,
} from "@/db/sessions";
import {
  consumeGitHubConnectionState,
  createGitHubConnectionState,
  disconnectRepository,
  activateRepositoryCandidate,
  findRepositoryWebhookTargets,
  getActiveRepositoryCandidateForMember,
  getPendingGitHubInstallation,
  getRepositoryConnectionForMember,
  saveRepositoryConnection,
  recordGitHubWebhookDelivery,
  reserveRepositoryCandidate,
  updateRepositoryPushState,
} from "@/db/repositories";

function identity(id: string, name: string) {
  return { providerUserId: `chatgpt-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

describe("D1 session persistence", () => {
  it("upserts users by stable provider identity", async () => {
    const first = await upsertUser(identity("owner", "Owner One"), env.DB);
    const updated = await upsertUser({ ...identity("owner", "Owner Two"), email: "new@example.com" }, env.DB);

    expect(updated.id).toBe(first.id);
    expect(updated.providerUserId).toBe("chatgpt-owner");
    expect(updated.displayName).toBe("Owner Two");
    expect(updated.email).toBe("new@example.com");
  });

  it("creates and lists only the current user's sessions", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const outsider = await upsertUser(identity("outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Persistent room", objective: "Ship sessions" }, env.DB);

    expect(await listSessionsForUser(outsider.id, env.DB)).toEqual([]);
    expect(await listSessionsForUser(owner.id, env.DB)).toEqual([
      expect.objectContaining({ id: created.session.id, role: "owner", memberCount: 1 }),
    ]);
  });

  it("accepts invites idempotently and enforces one membership", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const member = await upsertUser(identity("member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);

    await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);
    await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);
    const members = await getSessionMembers(created.session.id, owner.id, env.DB);
    expect(members).toHaveLength(2);
    expect(members?.map((item) => item.role)).toEqual(["owner", "member"]);
  });

  it("rotates and revokes reusable invites", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    const nextInvite = await rotateInvite(created.session.id, owner.id, env.DB);

    expect(nextInvite).not.toBe(created.inviteId);
    expect(await getInvitePreview(created.inviteId, env.DB)).toBeNull();
    expect(await getActiveInviteId(created.session.id, owner.id, env.DB)).toBe(nextInvite);
    expect(await revokeInvite(created.session.id, owner.id, env.DB)).toBe(true);
    expect(await getActiveInviteId(created.session.id, owner.id, env.DB)).toBeNull();
  });

  it("allows members to leave but prevents owner departure", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const member = await upsertUser(identity("member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(leaveSession(created.session.id, owner.id, env.DB)).resolves.toBe("owner");
    await expect(leaveSession(created.session.id, member.id, env.DB)).resolves.toBe("left");
    await expect(leaveSession(created.session.id, member.id, env.DB)).resolves.toBe("missing");
  });

  it("allows members to update the objective and conceals the session from outsiders", async () => {
    const owner = await upsertUser(identity("objective-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("objective-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("objective-outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: "First" }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    const updated = await updateSessionObjective(created.session.id, member.id, "Second", env.DB);
    expect(updated).toEqual(expect.objectContaining({ objective: "Second", role: "member" }));
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.session.updatedAt);
    await expect(updateSessionObjective(created.session.id, outsider.id, "Hidden", env.DB)).resolves.toBeNull();
  });

  it("persists one owner-configured repository connection and ordered checks", async () => {
    const owner = await upsertUser(identity("repo-owner", "Owner"), env.DB);
    const member = await upsertUser(identity("repo-member", "Member"), env.DB);
    const outsider = await upsertUser(identity("repo-outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Repository room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(createGitHubConnectionState(created.session.id, member.id, env.DB)).resolves.toBeNull();
    const stateId = await createGitHubConnectionState(created.session.id, owner.id, env.DB);
    expect(stateId).toBeTruthy();
    await expect(consumeGitHubConnectionState(stateId!, outsider.id, "installation-1", env.DB)).resolves.toBeNull();
    await expect(consumeGitHubConnectionState(stateId!, owner.id, "installation-1", env.DB)).resolves.toEqual({ sessionId: created.session.id });
    await expect(consumeGitHubConnectionState(stateId!, owner.id, "installation-1", env.DB)).resolves.toBeNull();
    await expect(getPendingGitHubInstallation(created.session.id, owner.id, env.DB)).resolves.toEqual({ stateId, installationId: "installation-1" });

    const saved = await saveRepositoryConnection(
      created.session.id,
      owner.id,
      stateId,
      "installation-1",
      {
        id: "repository-1",
        nodeId: "R_node",
        owner: "openfloor-test",
        name: "repository-integration",
        fullName: "openfloor-test/repository-integration",
        private: true,
        defaultBranch: "main",
      },
      "main",
      ["npm test", "npm run build"],
      env.DB,
    );
    expect(saved).toEqual(expect.objectContaining({
      repositoryId: "repository-1",
      repositoryFullName: "openfloor-test/repository-integration",
      status: "connected",
    }));
    expect(saved?.checkCommands.map((item) => item.command)).toEqual(["npm test", "npm run build"]);
    await expect(getRepositoryConnectionForMember(created.session.id, member.id, env.DB)).resolves.toEqual(saved);
    await expect(getRepositoryConnectionForMember(created.session.id, outsider.id, env.DB)).resolves.toBeNull();
    await expect(disconnectRepository(created.session.id, member.id, env.DB)).resolves.toBeNull();
    await expect(disconnectRepository(created.session.id, owner.id, env.DB)).resolves.toEqual(expect.objectContaining({ status: "disconnected" }));
  });

  it("persists one active candidate and reconciles webhook pushes idempotently", async () => {
    const owner = await upsertUser(identity("candidate-owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Candidate room", objective: null }, env.DB);
    const saved = await saveRepositoryConnection(created.session.id, owner.id, null, "installation-2", {
      id: "repository-2", nodeId: "R_two", owner: "openfloor-test", name: "candidate",
      fullName: "openfloor-test/candidate", private: true, defaultBranch: "main",
    }, "main", [], env.DB);
    const candidateId = crypto.randomUUID();
    const branch = `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`;
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, candidateId, branch, "main", "a".repeat(40), env.DB)).resolves.toBe(true);
    await expect(reserveRepositoryCandidate(created.session.id, owner.id, saved!.id, crypto.randomUUID(), `${branch}x`, "main", "a".repeat(40), env.DB)).resolves.toBe(false);
    await activateRepositoryCandidate(created.session.id, candidateId, "a".repeat(40), env.DB);
    expect(await getActiveRepositoryCandidateForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ branchName: branch, behindBase: false }));

    await expect(recordGitHubWebhookDelivery("delivery-1", "push", null, "installation-2", "repository-2", env.DB)).resolves.toBe(true);
    await expect(recordGitHubWebhookDelivery("delivery-1", "push", null, "installation-2", "repository-2", env.DB)).resolves.toBe(false);
    const [target] = await findRepositoryWebhookTargets("installation-2", "repository-2", env.DB);
    await updateRepositoryPushState(target.sessionId, "refs/heads/main", "b".repeat(40), target.baseBranch, target.candidateBranch, target.candidateSha, env.DB);
    expect(await getActiveRepositoryCandidateForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ behindBase: true, remoteBaseSha: "b".repeat(40) }));
    await updateRepositoryPushState(target.sessionId, `refs/heads/${branch}`, "c".repeat(40), target.baseBranch, target.candidateBranch, target.candidateSha, env.DB);
    expect(await getRepositoryConnectionForMember(created.session.id, owner.id, env.DB)).toEqual(expect.objectContaining({ status: "externally_modified" }));
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acceptInvite, createSession, upsertUser } from "@/db/sessions";
import { activateRepositoryCandidate, reserveRepositoryCandidate, saveRepositoryConnection } from "@/db/repositories";
import {
  activateRepositoryPreview,
  failRepositoryPreview,
  getPreviewProxyContext,
  getRepositoryPreview,
  getRepositoryPreviewExecutionContext,
  RepositoryPreviewCapacityError,
  RepositoryPreviewNotReadyError,
  reserveAutomaticRepositoryPreview,
  reserveRepositoryPreview,
  stopRepositoryPreview,
  takeExpiredRepositoryPreviews,
} from "@/db/previews";

function identity(id: string) {
  return { providerUserId: `preview-${id}`, email: `${id}@example.com`, displayName: id, fullName: id };
}

async function previewRoom(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`), env.DB);
  const outsider = await upsertUser(identity(`${suffix}-outsider`), env.DB);
  const created = await createSession(owner.id, { title: `Preview ${suffix}`, objective: null }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  const connection = await saveRepositoryConnection(created.session.id, owner.id, null, `installation-${suffix}`, {
    id: `repository-${suffix}`,
    nodeId: `node-${suffix}`,
    owner: "openfloor-test",
    name: suffix,
    fullName: `openfloor-test/${suffix}`,
    private: true,
    defaultBranch: "main",
  }, "main", env.DB);
  const candidateId = crypto.randomUUID();
  const sha = "a".repeat(40);
  await reserveRepositoryCandidate(
    created.session.id,
    owner.id,
    connection!.id,
    candidateId,
    `Preview ${suffix}`,
    "",
    `openfloor/${created.session.id.slice(0, 8)}/candidate/${candidateId.slice(0, 8)}`,
    "main",
    sha,
    env.DB,
  );
  await activateRepositoryCandidate(created.session.id, candidateId, sha, env.DB);
  return { sessionId: created.session.id, candidateId, sha, owner, member, outsider };
}

describe("repository preview lifecycle", () => {
  it("reserves for owner, conceals nonowners, and rejects stale generations", async () => {
    const room = await previewRoom("lease");
    await expect(reserveRepositoryPreview(room.sessionId, room.member.id, env.DB)).rejects.toThrow(RepositoryPreviewNotReadyError);
    await expect(reserveRepositoryPreview(room.sessionId, room.outsider.id, env.DB)).rejects.toThrow("Session not found");
    const first = await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
    expect(first).toMatchObject({ generation: 1, status: "provisioning", targetCandidateSha: room.sha });
    expect(await getRepositoryPreviewExecutionContext(first.id, first.generation, env.DB)).toMatchObject({ sandboxId: first.pendingSandboxId });
    const repeated = await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
    expect(repeated.workflowInstanceId).toBe(first.workflowInstanceId);
    await env.DB.prepare("UPDATE repository_candidates SET candidate_sha = ?, remote_candidate_sha = ? WHERE id = ?")
      .bind("c".repeat(40), "c".repeat(40), room.candidateId).run();
    expect(await activateRepositoryPreview(first.id, first.generation, {
      url: `https://8080-${first.pendingSandboxId}-token.preview.opnflr.com`,
      host: `8080-${first.pendingSandboxId}-token.preview.opnflr.com`,
      packageManager: "npm",
      script: "dev",
    }, env.DB)).toBeNull();
    await stopRepositoryPreview(room.sessionId, env.DB);
    expect(await getRepositoryPreviewExecutionContext(first.id, first.generation, env.DB)).toBeNull();
    expect(await getRepositoryPreview(room.sessionId, env.DB)).toBeNull();
  });

  it("keeps old preview available after failed automatic rebuild", async () => {
    const room = await previewRoom("fallback");
    const first = await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
    const activated = await activateRepositoryPreview(first.id, first.generation, {
      url: `https://8080-${first.pendingSandboxId}-token.preview.opnflr.com`,
      host: `8080-${first.pendingSandboxId}-token.preview.opnflr.com`,
      packageManager: "npm",
      script: "dev",
    }, env.DB);
    expect(activated).not.toBeNull();
    const nextSha = "b".repeat(40);
    await env.DB.prepare("UPDATE repository_candidates SET candidate_sha = ?, remote_candidate_sha = ? WHERE id = ?")
      .bind(nextSha, nextSha, room.candidateId).run();
    const rebuilding = await reserveAutomaticRepositoryPreview(room.sessionId, env.DB);
    expect(rebuilding).toMatchObject({ status: "provisioning", targetCandidateSha: nextSha, activeCandidateSha: room.sha });
    expect(await stopRepositoryPreview(room.sessionId, env.DB, first.generation)).toBeNull();
    await failRepositoryPreview(rebuilding!.id, rebuilding!.generation, "Unsupported root app", env.DB);
    expect(await getRepositoryPreview(room.sessionId, env.DB)).toMatchObject({
      status: "failed",
      targetCandidateSha: nextSha,
      activeCandidateSha: room.sha,
      url: `https://8080-${first.pendingSandboxId}-token.preview.opnflr.com`,
      failureReason: "Unsupported root app",
    });
    expect(await getPreviewProxyContext(`8080-${first.pendingSandboxId}-token.preview.opnflr.com`, room.member.id, env.DB)).toMatchObject({ sessionId: room.sessionId });
    expect(await getPreviewProxyContext(`8080-${first.pendingSandboxId}-token.preview.opnflr.com`, room.outsider.id, env.DB)).toBeNull();
    await stopRepositoryPreview(room.sessionId, env.DB);
  });

  it("atomically limits active or provisioning previews to three", async () => {
    const rooms = await Promise.all([0, 1, 2, 3].map((index) => previewRoom(`capacity-${index}`)));
    try {
      for (const room of rooms.slice(0, 3)) await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
      await expect(reserveRepositoryPreview(rooms[3].sessionId, rooms[3].owner.id, env.DB)).rejects.toBeInstanceOf(RepositoryPreviewCapacityError);
    } finally {
      for (const room of rooms) await stopRepositoryPreview(room.sessionId, env.DB);
    }
  });

  it("expires leases and revokes host lookup", async () => {
    const room = await previewRoom("expiry");
    const preview = await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
    await activateRepositoryPreview(preview.id, preview.generation, {
      url: `https://8080-${preview.pendingSandboxId}-token.preview.opnflr.com`,
      host: `8080-${preview.pendingSandboxId}-token.preview.opnflr.com`,
      packageManager: "pnpm",
      script: "start",
    }, env.DB);
    await env.DB.prepare("UPDATE repository_previews SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, preview.id).run();
    expect(await getRepositoryPreview(room.sessionId, env.DB)).toMatchObject({ status: "expired", url: null });
    expect(await getPreviewProxyContext(`8080-${preview.pendingSandboxId}-token.preview.opnflr.com`, room.owner.id, env.DB)).toBeNull();
    expect(await takeExpiredRepositoryPreviews(env.DB)).toEqual([expect.objectContaining({ sessionId: room.sessionId })]);
    expect(await getRepositoryPreview(room.sessionId, env.DB)).toBeNull();
  });
});

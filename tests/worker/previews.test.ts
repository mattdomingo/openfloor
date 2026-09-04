import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acceptInvite, createSession, upsertUser } from "@/db/sessions";
import { activateRepositoryCandidate, reserveRepositoryCandidate, saveRepositoryConnection } from "@/db/repositories";
import {
  activateRepositoryPreview,
  enqueueSandboxCleanup,
  failRepositoryPreview,
  finishSandboxCleanup,
  getPreviewProxyContext,
  getRepositoryPreview,
  getRepositoryPreviewExecutionContext,
  RepositoryPreviewCapacityError,
  RepositoryPreviewNotReadyError,
  reserveAutomaticRepositoryPreview,
  reserveRepositoryPreview,
  retrySandboxCleanup,
  stopRepositoryPreview,
  takeDueSandboxCleanup,
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
    expect(first).toMatchObject({ generation: 1, status: "provisioning", targetCandidateSha: room.sha, reservationCreated: true });
    expect(await getRepositoryPreviewExecutionContext(first.id, first.generation, env.DB)).toMatchObject({ sandboxId: first.pendingSandboxId });
    const repeated = await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
    expect(repeated.workflowInstanceId).toBe(first.workflowInstanceId);
    expect(repeated.reservationCreated).toBe(false);
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

  it("returns one generation to concurrent same-session starts", async () => {
    const room = await previewRoom("generation-race");
    const results = await Promise.all([
      reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB),
      reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB),
    ]);
    expect(new Set(results.map((preview) => preview.generation))).toEqual(new Set([1]));
    expect(results.filter((preview) => preview.reservationCreated)).toHaveLength(1);
    await stopRepositoryPreview(room.sessionId, env.DB);
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
    expect(await reserveAutomaticRepositoryPreview(room.sessionId, env.DB)).toBeNull();
    expect(await stopRepositoryPreview(room.sessionId, env.DB, first.generation)).toBeNull();
    await failRepositoryPreview(rebuilding!.id, rebuilding!.generation, "Unsupported root app", env.DB);
    expect(await getRepositoryPreview(room.sessionId, env.DB)).toMatchObject({
      status: "failed",
      targetCandidateSha: nextSha,
      activeCandidateSha: room.sha,
      url: `https://8080-${first.pendingSandboxId}-token.preview.opnflr.com`,
      failureReason: "Unsupported root app",
    });
    expect(await getPreviewProxyContext(`8080-${first.pendingSandboxId}-token.preview.opnflr.com`, room.member.id, false, env.DB)).toMatchObject({ sessionId: room.sessionId });
    expect(await getPreviewProxyContext(`8080-${first.pendingSandboxId}-token.preview.opnflr.com`, room.outsider.id, false, env.DB)).toBeNull();
    await stopRepositoryPreview(room.sessionId, env.DB);
  });

  it("atomically limits active or provisioning previews to three", async () => {
    const rooms = await Promise.all([0, 1, 2, 3].map((index) => previewRoom(`capacity-${index}`)));
    try {
      const results = await Promise.allSettled(rooms.map((room) => reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(failure?.reason).toBeInstanceOf(RepositoryPreviewCapacityError);
    } finally {
      for (const room of rooms) await stopRepositoryPreview(room.sessionId, env.DB);
    }
  });

  it("releases capacity after an initial build fails", async () => {
    const rooms = await Promise.all([0, 1, 2, 3].map((index) => previewRoom(`failed-capacity-${index}`)));
    try {
      const first = await reserveRepositoryPreview(rooms[0].sessionId, rooms[0].owner.id, env.DB);
      await failRepositoryPreview(first.id, first.generation, "Unsupported root app", env.DB);
      const remaining = await Promise.all(rooms.slice(1).map((room) => reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB)));
      expect(remaining).toHaveLength(3);
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
    expect(await getPreviewProxyContext(`8080-${preview.pendingSandboxId}-token.preview.opnflr.com`, room.owner.id, false, env.DB)).toBeNull();
    expect(await takeExpiredRepositoryPreviews(env.DB)).toEqual([expect.objectContaining({ sessionId: room.sessionId })]);
    expect(await getRepositoryPreview(room.sessionId, env.DB)).toBeNull();
  });

  it("does not revive an expired active sandbox when owner starts again", async () => {
    const room = await previewRoom("expired-restart");
    const first = await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
    const expiredSandboxId = first.pendingSandboxId!;
    await activateRepositoryPreview(first.id, first.generation, {
      url: `https://8080-${first.pendingSandboxId}-token.preview.opnflr.com`,
      host: `8080-${first.pendingSandboxId}-token.preview.opnflr.com`,
      packageManager: "npm",
      script: "dev",
    }, env.DB);
    await env.DB.prepare("UPDATE repository_previews SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, first.id).run();

    const restarted = await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
    expect(restarted).toMatchObject({
      generation: first.generation + 1,
      status: "provisioning",
      activeCandidateSha: null,
      activeSandboxId: null,
      activeUrl: null,
      activeHost: null,
      detectedPackageManager: null,
      detectedScript: null,
    });
    expect(await takeDueSandboxCleanup(env.DB)).toContain(expiredSandboxId);
    await stopRepositoryPreview(room.sessionId, env.DB);
  });

  it("enforces early-access revocation at proxy time", async () => {
    const room = await previewRoom("admission");
    const preview = await reserveRepositoryPreview(room.sessionId, room.owner.id, env.DB);
    const host = `8080-${preview.pendingSandboxId}-token.preview.opnflr.com`;
    await activateRepositoryPreview(preview.id, preview.generation, {
      url: `https://${host}`,
      host,
      packageManager: "npm",
      script: "dev",
    }, env.DB);
    await env.DB.prepare("UPDATE users SET early_access_granted_at = ?, early_access_revoked_at = NULL WHERE id = ?")
      .bind(Date.now(), room.member.id).run();
    expect(await getPreviewProxyContext(host, room.member.id, true, env.DB)).not.toBeNull();
    await env.DB.prepare("UPDATE users SET early_access_revoked_at = ? WHERE id = ?").bind(Date.now(), room.member.id).run();
    expect(await getPreviewProxyContext(host, room.member.id, true, env.DB)).toBeNull();
    await stopRepositoryPreview(room.sessionId, env.DB);
  });

  it("keeps failed sandbox destruction durable until a later success", async () => {
    const id = `preview-cleanup-${crypto.randomUUID()}`;
    const now = Date.now();
    await enqueueSandboxCleanup([id], env.DB, now);
    expect(await takeDueSandboxCleanup(env.DB, now)).toContain(id);
    await retrySandboxCleanup(id, "temporary failure", env.DB);
    expect(await takeDueSandboxCleanup(env.DB, now)).not.toContain(id);
    expect(await takeDueSandboxCleanup(env.DB, now + 10 * 60 * 1_000 + 1_000)).toContain(id);
    await finishSandboxCleanup(id, env.DB);
    expect(await takeDueSandboxCleanup(env.DB, now + 10 * 60 * 1_000 + 1_000)).not.toContain(id);
  });
});

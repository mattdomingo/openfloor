import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createFloorAgent, createFloorQueueItem } from "@/db/floor";
import {
  advanceConflictAfterFailure,
  createConflictResolverRun,
  getConflictSelectionsForCase,
  getConflictSnapshotArtifact,
  getMergeConflictCases,
  recordConflictSelections,
  recordIntegrationConflict,
} from "@/db/conflicts";
import { acceptInvite, createSession, upsertUser } from "@/db/sessions";
import { recordPreparedConflict } from "@/db/conflict-decisions";
import { readSnapshotManifest, readSnapshotFile } from "@/lib/conflict-snapshot-server";
import { parseAgentInput } from "@/lib/validation";

function identity(id: string, name: string) {
  return { providerUserId: `selection-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function seed(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const unrelated = await upsertUser(identity(`${suffix}-unrelated`, "Unrelated Member"), env.DB);
  const outsider = await upsertUser(identity(`${suffix}-outsider`, "Outsider Example"), env.DB);
  const created = await createSession(owner.id, { title: `Selections ${suffix}`, objective: "Preserve both changes" }, env.DB);
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
  await env.DB.prepare("UPDATE floor_queue_items SET status = 'blocked' WHERE id = ?").bind(queueItemId).run();
  const recorded = await recordIntegrationConflict(sourceRunId, "GitHub merge conflict", env.DB);
  if (!recorded) throw new Error("Conflict case was not recorded");
  return { sessionId: created.session.id, owner, member, unrelated, outsider, agentId, queueItemId, sourceRunId, caseId: recorded.caseId };
}

/** Mirrors what worker/agent-run-workflow.ts writes after a resolver
 * attempt: a failed resolver run whose merge_conflict_attempts row is linked
 * to a conflict_snapshot artifact. db/conflicts.ts never touches R2 itself
 * (route layer does — see app/api/.../snapshot/route.ts), so the r2Key here
 * is just an opaque string these tests can assert against. */
async function seedFailedResolverWithSnapshot(caseId: string, r2Key: string) {
  const resolver = await createConflictResolverRun(caseId, "automatic", env.DB);
  if (!resolver) throw new Error("Resolver run was not created");
  await env.DB.prepare(
    `INSERT INTO agent_run_artifacts (id, run_id, kind, r2_key, content_type, size_bytes, created_at)
     VALUES (?, ?, 'conflict_snapshot', ?, 'application/json', 42, ?)`,
  ).bind(crypto.randomUUID(), resolver.runId, r2Key, Date.now()).run();
  await env.DB.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").bind(resolver.runId).run();
  await advanceConflictAfterFailure(resolver.runId, "The automatic resolver could not resolve every conflict.", env.DB, false);
  return resolver.runId;
}

describe("manual conflict resolution (hunk selections)", () => {
  it("marks hasSnapshot only once a resolver attempt captured one", async () => {
    const room = await seed("has-snapshot");
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0].hasSnapshot).toBe(false);
    await seedFailedResolverWithSnapshot(room.caseId, "conflicts/case/run/snapshot.json");
    expect((await getMergeConflictCases(room.sessionId, env.DB))[0].hasSnapshot).toBe(true);
  });

  it("authorizes the owner and an original prompt author, conceals it from everyone else", async () => {
    const room = await seed("authorize");
    const runId = await seedFailedResolverWithSnapshot(room.caseId, "conflicts/case/run/snapshot.json");
    const ownerAccess = await getConflictSnapshotArtifact(room.sessionId, room.caseId, room.owner.id, env.DB);
    expect(ownerAccess).toMatchObject({ runId, r2Key: "conflicts/case/run/snapshot.json" });
    const authorAccess = await getConflictSnapshotArtifact(room.sessionId, room.caseId, room.member.id, env.DB);
    expect(authorAccess).toMatchObject({ runId });
    await expect(getConflictSnapshotArtifact(room.sessionId, room.caseId, room.unrelated.id, env.DB)).resolves.toBe("forbidden");
    await expect(getConflictSnapshotArtifact(room.sessionId, room.caseId, room.outsider.id, env.DB)).resolves.toBe("forbidden");
  });

  it("reports not_found before any resolver attempt has captured a snapshot", async () => {
    const room = await seed("not-found");
    await expect(getConflictSnapshotArtifact(room.sessionId, room.caseId, room.owner.id, env.DB)).resolves.toBe("not_found");
  });

  it("records a complete selection set, resumes the case, and makes it readable via getConflictSelectionsForCase", async () => {
    const room = await seed("record");
    const runId = await seedFailedResolverWithSnapshot(room.caseId, "conflicts/case/run/snapshot.json");
    const selections = [
      { path: "src/shared.ts", hunkIndex: 0, choice: "ours" as const },
      { path: "src/shared.ts", hunkIndex: 1, choice: "theirs" as const },
    ];
    await expect(recordConflictSelections(room.sessionId, room.caseId, room.member.id, runId, selections, env.DB)).resolves.toBe("recorded");
    const cases = await getMergeConflictCases(room.sessionId, env.DB);
    expect(cases[0]).toEqual(expect.objectContaining({ status: "pending" }));
    const stored = await getConflictSelectionsForCase(room.caseId, env.DB);
    expect(stored?.snapshotRunId).toBe(runId);
    expect(stored?.selections).toEqual(expect.arrayContaining(selections));
  });

  it("rejects a stale snapshot id and an unauthorized submitter", async () => {
    const room = await seed("stale");
    const runId = await seedFailedResolverWithSnapshot(room.caseId, "conflicts/case/run/snapshot.json");
    const selections = [{ path: "src/shared.ts", hunkIndex: 0, choice: "ours" as const }];
    await expect(recordConflictSelections(room.sessionId, room.caseId, room.owner.id, "not-the-latest-run", selections, env.DB)).resolves.toBe("stale");
    await expect(recordConflictSelections(room.sessionId, room.caseId, room.unrelated.id, runId, selections, env.DB)).resolves.toBe("missing");
    await expect(recordConflictSelections(room.sessionId, room.caseId, room.outsider.id, runId, selections, env.DB)).resolves.toBe("missing");
  });

  it("resolves getConflictSelectionsForCase to null with no recorded selections", async () => {
    const room = await seed("no-selections");
    await seedFailedResolverWithSnapshot(room.caseId, "conflicts/case/run/snapshot.json");
    await expect(getConflictSelectionsForCase(room.caseId, env.DB)).resolves.toBeNull();
  });
});


describe("manual selection race and session boundaries", () => {
  it("conceals another session's snapshot from an owner", async () => {
    const own = await seed("cross-session-owner");
    const other = await seed("cross-session-target");
    await seedFailedResolverWithSnapshot(other.caseId, "private/other.json");
    expect(await getConflictSnapshotArtifact(own.sessionId, other.caseId, own.owner.id, env.DB)).toBe("forbidden");
  });

  it("a rejected second submission changes neither choices nor revision", async () => {
    const room = await seed("rejected-write");
    const runId = await seedFailedResolverWithSnapshot(room.caseId, "snapshot.json");
    const choices = [{ path: "src/shared feature.ts", hunkIndex: 0, choice: "ours" as const }];
    expect(await recordConflictSelections(room.sessionId, room.caseId, room.owner.id, runId, choices, env.DB)).toBe("recorded");
    const before = await env.DB.prepare("SELECT floor_revision FROM sessions WHERE id = ?").bind(room.sessionId).first();
    expect(await recordConflictSelections(room.sessionId, room.caseId, room.member.id, runId, [{ ...choices[0], choice: "theirs" }], env.DB)).toBe("stale");
    expect((await getConflictSelectionsForCase(room.caseId, env.DB))?.selections).toEqual(choices);
    expect(await env.DB.prepare("SELECT floor_revision FROM sessions WHERE id = ?").bind(room.sessionId).first()).toEqual(before);
  });
});


describe("immutable snapshot storage", () => {
  it("reports missing and malformed manifests while concealing other sessions", async () => {
    const room = await seed("manifest-storage");
    const other = await seed("manifest-other");
    const resolver = (await createConflictResolverRun(room.caseId, "automatic", env.DB))!;
    const manifestKey = `conflicts/${room.caseId}/${resolver.runId}/v2/manifest.json`;
    await recordPreparedConflict({ runId: resolver.runId, manifestKey, paths: ["src/shared.ts"] }, env.DB);
    await expect(readSnapshotManifest(other.sessionId, room.caseId, other.owner.id)).resolves.toBeNull();
    await expect(readSnapshotManifest(room.sessionId, room.caseId, room.owner.id)).rejects.toThrow("Snapshot files are unavailable");
    await (env as unknown as { PREFLIGHT_LOGS: R2Bucket }).PREFLIGHT_LOGS.put(manifestKey, "{broken");
    await expect(readSnapshotManifest(room.sessionId, room.caseId, room.owner.id)).rejects.toThrow("malformed");
    await (env as unknown as { PREFLIGHT_LOGS: R2Bucket }).PREFLIGHT_LOGS.put(manifestKey, JSON.stringify({ version: 2, files: [{ path: "../escape" }] }));
    await expect(readSnapshotManifest(room.sessionId, room.caseId, room.owner.id)).rejects.toThrow("Invalid conflict manifest");
  });

  it("refuses missing, truncated, and mismatched complete file content", async () => {
    const entry = { path: "src/space ü.ts", file: "0.json", kind: "content" as const, fingerprint: "a".repeat(64), wholeFileOnly: true, canEdit: true, hunkCount: 0 };
    const manifestKey = "conflicts/storage-validation/manifest.json";
    await expect(readSnapshotFile(manifestKey, entry)).rejects.toThrow("file is unavailable");
    const file = { path: entry.path, fingerprint: entry.fingerprint, truncated: false, wholeFileOnly: true,
      stages: [null, null, null], kind: "content", base: "", ours: "candidate", theirs: "incoming", merged: "result" };
    await (env as unknown as { PREFLIGHT_LOGS: R2Bucket }).PREFLIGHT_LOGS.put("conflicts/storage-validation/0.json", JSON.stringify({ ...file, truncated: true }));
    await expect(readSnapshotFile(manifestKey, entry)).rejects.toThrow("Invalid conflict file");
    await (env as unknown as { PREFLIGHT_LOGS: R2Bucket }).PREFLIGHT_LOGS.put("conflicts/storage-validation/0.json", JSON.stringify({ ...file, fingerprint: "b".repeat(64) }));
    await expect(readSnapshotFile(manifestKey, entry)).rejects.toThrow("Invalid conflict file");
    await (env as unknown as { PREFLIGHT_LOGS: R2Bucket }).PREFLIGHT_LOGS.put("conflicts/storage-validation/0.json", JSON.stringify(file));
    await expect(readSnapshotFile(manifestKey, entry)).resolves.toMatchObject({ path: entry.path, merged: "result" });
  });
});

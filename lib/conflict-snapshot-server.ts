import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { conflictAccess } from "@/db/conflict-decisions";
import { parseConflictHunks } from "./conflict-hunks";
import type { CapturedConflictFile, ConflictManifest } from "./conflict-workspace";
import { ConflictSnapshotError } from "./conflict-resolution";
import type { ManualConflictSelection } from "./conflict-resolution";

type Bucket = { get(key: string): Promise<{ text(): Promise<string> } | null> };
function bucket(): Bucket {
  const value = (env as unknown as { PREFLIGHT_LOGS?: Bucket }).PREFLIGHT_LOGS;
  if (!value) throw new ConflictSnapshotError("Conflict storage is unavailable. Try again.");
  return value;
}
export async function readSnapshotManifest(sessionId: string, caseId: string, userId: string) {
  const database = getDb();
  if (!await conflictAccess(sessionId, caseId, userId, false, database)) return null;
  const row = await database.prepare(`SELECT sn.id, sn.run_id AS runId, sn.manifest_key AS manifestKey, sn.candidate_sha AS candidateSha,
    sn.source_run_id AS sourceRunId, sn.source_commit_sha AS sourceCommitSha, mc.revision
    FROM merge_conflict_cases mc JOIN merge_conflict_snapshots sn ON sn.id = mc.snapshot_id AND sn.case_id = mc.id
    WHERE mc.id = ? AND mc.session_id = ?`).bind(caseId, sessionId).first<{
      id: string; runId: string; manifestKey: string; candidateSha: string; sourceRunId: string; sourceCommitSha: string; revision: number;
    }>();
  if (!row) return { pending: true as const };
  const object = await bucket().get(row.manifestKey);
  if (!object) throw new ConflictSnapshotError("Snapshot files are unavailable. Refresh the conflict versions.");
  const encoded = await object.text();
  if (encoded.length > 1_000_000) throw new ConflictSnapshotError("Invalid conflict manifest");
  const manifest = parseSnapshotJson(encoded) as ConflictManifest;
  if (!manifest || manifest.version !== 2 || !Array.isArray(manifest.files) || manifest.files.length > 1000
    || manifest.files.some((file) => !file || typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.split("/").some((part) => !part || part === ".." || part === ".git") || typeof file.wholeFileOnly !== "boolean" || typeof file.canEdit !== "boolean" || !Number.isSafeInteger(file.hunkCount) || file.hunkCount < 0 || !/^\d+\.json$/.test(file.file) || !/^[0-9a-f]{64}$/.test(file.fingerprint))
    || new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) throw new ConflictSnapshotError("Invalid conflict manifest");
  return { pending: false as const, ...row, manifest };
}
export async function readSnapshotFile(manifestKey: string, entry: ConflictManifest["files"][number]): Promise<CapturedConflictFile> {
  const object = await bucket().get(`${manifestKey.slice(0, manifestKey.lastIndexOf("/"))}/${entry.file}`);
  if (!object) throw new ConflictSnapshotError("This conflict file is unavailable. Refresh the conflict versions.");
  const encoded = await object.text();
  if (encoded.length > 16_000_000) throw new ConflictSnapshotError("Conflict file exceeds its bound");
  const file = parseSnapshotJson(encoded) as CapturedConflictFile;
  if (!file || file.path !== entry.path || file.fingerprint !== entry.fingerprint || file.truncated || !Array.isArray(file.stages)
    || file.stages.length !== 3 || file.stages.some((stage) => stage !== null && (!stage || !/^[0-9a-f]{40}$/.test(stage.oid) || !["100644", "100755", "120000", "160000"].includes(stage.mode))) || typeof file.wholeFileOnly !== "boolean" || !["content", "binary", "delete_modify", "modify_delete"].includes(file.kind)
    || [file.base, file.ours, file.theirs, file.merged].some((value) => value !== null && typeof value !== "string")) throw new ConflictSnapshotError("Invalid conflict file");
  return file;
}
export async function validateManualProposal(manifestKey: string, manifest: ConflictManifest, selections: ManualConflictSelection[]) {
  const byPath = new Map<string, ManualConflictSelection[]>();
  for (const selection of selections) byPath.set(selection.path, [...(byPath.get(selection.path) ?? []), selection]);
  if (byPath.size !== manifest.files.length || [...byPath.keys()].some((path) => !manifest.files.some((file) => file.path === path))) return false;
  for (const entry of manifest.files) {
    const choices = byPath.get(entry.path)!;
    const file = await readSnapshotFile(manifestKey, entry);
    if (choices.length === 1 && choices[0].hunkIndex === -1) {
      if (choices[0].choice === "both" || choices[0].choice === "edited" && !entry.canEdit) return false;
      continue;
    }
    if (entry.wholeFileOnly || choices.some((choice) => choice.hunkIndex < 0 || choice.choice === "edited")) return false;
    if (file.merged === null) return false;
    const hunks = parseConflictHunks(file.merged);
    if (hunks.length !== choices.length || !hunks.every((hunk) => choices.some((choice) => choice.hunkIndex === hunk.index))) return false;
  }
  return true;
}

function parseSnapshotJson(encoded: string): unknown {
  try { return JSON.parse(encoded); }
  catch { throw new ConflictSnapshotError("Conflict snapshot is malformed. Refresh file versions."); }
}

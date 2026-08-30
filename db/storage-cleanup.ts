import { getDb, type D1DatabaseLike } from "./index";

export type StorageCleanupBucket = "preflight_logs" | "user_avatars";

const HOLD_AFTER_EMPTY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

type CleanupPrefix = { bucket: StorageCleanupBucket; prefix: string; sourceSessionId: string | null };

async function sessionPrefixes(sessionId: string, database: D1DatabaseLike): Promise<CleanupPrefix[]> {
  const [runs, preflights, conflicts] = await Promise.all([
    database.prepare("SELECT id FROM agent_runs WHERE session_id = ?").bind(sessionId).all<{ id: string }>(),
    database.prepare("SELECT id FROM repository_preflights WHERE session_id = ?").bind(sessionId).all<{ id: string }>(),
    database.prepare("SELECT id FROM merge_conflict_cases WHERE session_id = ?").bind(sessionId).all<{ id: string }>(),
  ]);
  return [
    { bucket: "preflight_logs", prefix: `sessions/${sessionId}/`, sourceSessionId: sessionId },
    ...runs.results.map(({ id }) => ({ bucket: "preflight_logs" as const, prefix: `runs/${id}/`, sourceSessionId: sessionId })),
    ...preflights.results.map(({ id }) => ({ bucket: "preflight_logs" as const, prefix: `preflights/${id}/`, sourceSessionId: sessionId })),
    ...conflicts.results.map(({ id }) => ({ bucket: "preflight_logs" as const, prefix: `conflicts/${id}/`, sourceSessionId: sessionId })),
  ];
}

async function enqueue(prefixes: CleanupPrefix[], database: D1DatabaseLike, now: number): Promise<void> {
  const unique = new Map(prefixes.map((prefix) => [`${prefix.bucket}:${prefix.prefix}`, prefix]));
  const rows = [...unique.values()];
  for (let offset = 0; offset < rows.length; offset += 50) {
    await database.batch(rows.slice(offset, offset + 50).map((row) => database.prepare(
      `INSERT INTO storage_cleanup_prefixes (bucket, prefix, source_session_id, not_before, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bucket, prefix) DO UPDATE SET source_session_id = COALESCE(storage_cleanup_prefixes.source_session_id, excluded.source_session_id), updated_at = excluded.updated_at`,
    ).bind(row.bucket, row.prefix, row.sourceSessionId, now, now)));
  }
}

/** Call before deleting a session. Cleaner skips these rows while session exists. */
export async function enqueueSessionStorageCleanup(sessionId: string, database = getDb(), now = Date.now()): Promise<void> {
  await enqueue(await sessionPrefixes(sessionId, database), database, now);
}

/** Call before scrubbing an account row. Avatar prefix has no session guard. */
export async function enqueueAccountStorageCleanup(userId: string, database = getDb(), now = Date.now()): Promise<void> {
  await enqueue([{ bucket: "user_avatars", prefix: `users/${userId}/avatar`, sourceSessionId: null }], database, now);
}

export const storageCleanupTiming = { HOLD_AFTER_EMPTY_MS, RETRY_MS };

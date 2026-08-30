import type { D1DatabaseLike } from "@/db";
import { storageCleanupTiming } from "@/db/storage-cleanup";

type CleanupBucket = {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
};

export type StorageCleanupEnvironment = {
  DB: D1DatabaseLike;
  PREFLIGHT_LOGS: CleanupBucket;
  USER_AVATARS: CleanupBucket;
};

export async function sweepStorageCleanup(env: StorageCleanupEnvironment): Promise<void> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT bucket, prefix, source_session_id AS sourceSessionId, not_before AS notBefore,
            empty_scans AS emptyScans
     FROM storage_cleanup_prefixes WHERE not_before <= ? ORDER BY updated_at LIMIT 25`,
  ).bind(now).all<{ bucket: "preflight_logs" | "user_avatars"; prefix: string; sourceSessionId: string | null; notBefore: number; emptyScans: number }>();
  for (const row of rows.results) {
    try {
      if (row.sourceSessionId) {
        const live = await env.DB.prepare("SELECT 1 AS present FROM sessions WHERE id = ?").bind(row.sourceSessionId).first();
        if (live) continue;
      }
      if (row.bucket !== "preflight_logs" && row.bucket !== "user_avatars") throw new Error("Unknown cleanup bucket");
      const bucket = row.bucket === "preflight_logs" ? env.PREFLIGHT_LOGS : env.USER_AVATARS;
      const keys: string[] = [];
      let cursor: string | undefined;
      let truncated = true;
      for (let page = 0; page < 10 && truncated; page += 1) {
        const listed = await bucket.list({ prefix: row.prefix, cursor, limit: 1000 });
        keys.push(...listed.objects.map((object) => object.key));
        truncated = listed.truncated;
        cursor = listed.cursor;
      }
      for (let offset = 0; offset < keys.length; offset += 1000) {
        await bucket.delete(keys.slice(offset, offset + 1000));
      }
      const nextEmptyScans = keys.length === 0 ? row.emptyScans + 1 : 0;
      if (nextEmptyScans >= 2) {
        await env.DB.prepare("DELETE FROM storage_cleanup_prefixes WHERE bucket = ? AND prefix = ?").bind(row.bucket, row.prefix).run();
      } else {
        const nextAt = keys.length === 0 ? now + storageCleanupTiming.HOLD_AFTER_EMPTY_MS : now + storageCleanupTiming.RETRY_MS;
        await env.DB.prepare(
          "UPDATE storage_cleanup_prefixes SET not_before = ?, last_scanned_at = ?, empty_scans = ?, updated_at = ? WHERE bucket = ? AND prefix = ?",
        ).bind(nextAt, now, nextEmptyScans, now, row.bucket, row.prefix).run();
      }
    } catch {
      // One broken bucket operation must not block other cleanup jobs. Keep
      // the durable row and retry after the short backoff.
      await env.DB.prepare("UPDATE storage_cleanup_prefixes SET not_before = ?, updated_at = ? WHERE bucket = ? AND prefix = ?")
        .bind(now + storageCleanupTiming.RETRY_MS, now, row.bucket, row.prefix).run();
    }
  }
}

import { getDb, type D1DatabaseLike } from "./index";
import { EARLY_ACCESS_RETENTION_MS, type EarlyAccessBindings, signWaitlistSheetPayload } from "@/lib/early-access";

export type WaitlistStatus = "waiting" | "admitted";
export type WaitlistRecord = {
  id: string;
  email: string;
  name: string;
  status: WaitlistStatus;
  consentVersion: string;
  consentedAt: number;
  sheetSyncState: "pending" | "synced";
  sheetSyncAttempts: number;
  sheetNextAttemptAt: number;
  sheetLastError: string | null;
  sheetSyncedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

const WAITLIST_COLUMNS = `id, email, name, status, consent_version AS consentVersion, consented_at AS consentedAt,
  sheet_sync_state AS sheetSyncState, sheet_sync_attempts AS sheetSyncAttempts,
  sheet_next_attempt_at AS sheetNextAttemptAt, sheet_last_error AS sheetLastError,
  sheet_synced_at AS sheetSyncedAt, created_at AS createdAt, updated_at AS updatedAt`;

export async function upsertWaitlistEntry(
  input: { name: string; email: string; consentVersion: string },
  database = getDb(),
  now = Date.now(),
): Promise<WaitlistRecord> {
  const record = await database.prepare(
    `INSERT INTO early_access_waitlist
       (id, email, name, status, consent_version, consented_at, sheet_sync_state,
        sheet_sync_attempts, sheet_next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, 'waiting', ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name,
       consent_version = excluded.consent_version,
       consented_at = excluded.consented_at,
       sheet_sync_state = 'pending',
       sheet_sync_attempts = 0,
       sheet_next_attempt_at = excluded.sheet_next_attempt_at,
       sheet_last_error = NULL,
       sheet_synced_at = NULL,
       updated_at = excluded.updated_at
     RETURNING ${WAITLIST_COLUMNS}`,
  ).bind(crypto.randomUUID(), input.email, input.name, input.consentVersion, now, now, now, now).first<WaitlistRecord>();
  if (!record) throw new Error("Unable to save the early-access waitlist entry.");
  return record;
}

export async function grantEarlyAccess(
  userId: string,
  source: "passcode" | "manual",
  database = getDb(),
  now = Date.now(),
): Promise<boolean> {
  const result = await database.prepare(
    `UPDATE users SET early_access_granted_at = ?, early_access_grant_source = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND early_access_revoked_at IS NULL`,
  ).bind(now, source, now, userId).run();
  if ((result.meta?.changes ?? 0) === 0) return false;
  const user = await database.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  if (user) await markWaitlistAdmitted(user.email, database, now);
  return true;
}

export async function revokeEarlyAccess(userId: string, database = getDb(), now = Date.now()): Promise<boolean> {
  const result = await database.prepare(
    `UPDATE users SET early_access_revoked_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
  ).bind(now, now, userId).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function manuallyRestoreEarlyAccess(userId: string, database = getDb(), now = Date.now()): Promise<boolean> {
  const result = await database.prepare(
    `UPDATE users SET early_access_granted_at = ?, early_access_revoked_at = NULL,
       early_access_grant_source = 'manual', updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).bind(now, now, userId).run();
  if ((result.meta?.changes ?? 0) === 0) return false;
  const user = await database.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  if (user) await markWaitlistAdmitted(user.email, database, now);
  return true;
}

export async function earlyAccessActiveForUser(userId: string, database: D1DatabaseLike): Promise<boolean> {
  const row = await database.prepare(
    "SELECT 1 AS active FROM users WHERE id = ? AND deleted_at IS NULL AND early_access_granted_at IS NOT NULL AND early_access_revoked_at IS NULL",
  ).bind(userId).first<{ active: number }>();
  return Boolean(row);
}

export async function listPendingWaitlistSync(database: D1DatabaseLike, now = Date.now(), limit = 25): Promise<WaitlistRecord[]> {
  const rows = await database.prepare(
    `SELECT ${WAITLIST_COLUMNS} FROM early_access_waitlist
     WHERE sheet_sync_state = 'pending' AND sheet_next_attempt_at <= ?
     ORDER BY sheet_next_attempt_at, created_at LIMIT ?`,
  ).bind(now, limit).all<WaitlistRecord>();
  return rows.results;
}

export async function syncWaitlistRecordToSheet(
  record: WaitlistRecord,
  database: D1DatabaseLike,
  bindings: EarlyAccessBindings,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<boolean> {
  const url = bindings.WAITLIST_SHEET_WEBHOOK_URL;
  const secret = bindings.WAITLIST_SHEET_WEBHOOK_SECRET;
  if (!url || !secret) return false;
  const payload = JSON.stringify({
    id: record.id,
    submittedAt: record.createdAt,
    updatedAt: record.updatedAt,
    name: record.name,
    email: record.email,
    status: record.status,
  });
  const signature = await signWaitlistSheetPayload(secret, now, payload);
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timestamp: now, payload, signature }),
      // Apps Script web apps can take several seconds on a cold start. Keep
      // the request bounded, but do not turn a successful execution into a
      // false Sheet-sync failure at the old three-second cutoff.
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const acknowledgement = await response.json().catch(() => null) as { ok?: unknown } | null;
    if (acknowledgement?.ok !== true) throw new Error("Sheet webhook did not acknowledge the record");
    await database.prepare(
      `UPDATE early_access_waitlist SET sheet_sync_state = 'synced', sheet_synced_at = ?,
         sheet_last_error = NULL WHERE id = ? AND updated_at = ?`,
    ).bind(now, record.id, record.updatedAt).run();
    return true;
  } catch (error) {
    const attempts = record.sheetSyncAttempts + 1;
    const delay = Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 8));
    const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown Sheet synchronization error";
    await database.prepare(
      `UPDATE early_access_waitlist SET sheet_sync_state = 'pending', sheet_sync_attempts = ?,
         sheet_next_attempt_at = ?, sheet_last_error = ? WHERE id = ? AND updated_at = ?`,
    ).bind(attempts, now + delay, message, record.id, record.updatedAt).run();
    return false;
  }
}

export async function sweepWaitlistSheetSync(
  database: D1DatabaseLike,
  bindings: EarlyAccessBindings,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<number> {
  if (!bindings.WAITLIST_SHEET_WEBHOOK_URL || !bindings.WAITLIST_SHEET_WEBHOOK_SECRET) return 0;
  const records = await listPendingWaitlistSync(database, now);
  let synced = 0;
  for (const record of records) {
    if (await syncWaitlistRecordToSheet(record, database, bindings, fetcher, now)) synced += 1;
  }
  return synced;
}

export async function purgeExpiredWaitlist(database: D1DatabaseLike, now = Date.now(), limit = 100): Promise<number> {
  const expired = await database.prepare(
    "SELECT id FROM early_access_waitlist WHERE updated_at < ? ORDER BY updated_at LIMIT ?",
  ).bind(now - EARLY_ACCESS_RETENTION_MS, limit).all<{ id: string }>();
  if (expired.results.length === 0) return 0;
  await database.batch(expired.results.map(({ id }) => database.prepare("DELETE FROM early_access_waitlist WHERE id = ?").bind(id)));
  return expired.results.length;
}

async function markWaitlistAdmitted(email: string, database: D1DatabaseLike, now: number): Promise<void> {
  await database.prepare(
    `UPDATE early_access_waitlist SET status = 'admitted', sheet_sync_state = 'pending',
       sheet_sync_attempts = 0, sheet_next_attempt_at = ?, sheet_last_error = NULL,
       sheet_synced_at = NULL, updated_at = ? WHERE email = ?`,
  ).bind(now, now, email).run();
}

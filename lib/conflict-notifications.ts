import type { MergeConflictCase } from "./floor-types";

export const CONFLICT_ALERT_STORAGE_KEY = "openfloor:browserConflictAlerts";
const CLAIM_PREFIX = "openfloor:conflictAlert:";
const CLAIM_TTL_MS = 24 * 60 * 60 * 1_000;

export function conflictAttentionEvent(conflict: MergeConflictCase): string | null {
  return conflict.status === "awaiting_input" || conflict.status === "failed"
    ? `${conflict.id}:${conflict.status}:${conflict.updatedAt}`
    : null;
}

/** Synchronous fallback and durable receipt used inside the Web Lock. */
export function claimConflictAlert(storage: Pick<Storage, "getItem" | "setItem">, eventId: string, now = Date.now()): boolean {
  const key = `${CLAIM_PREFIX}${eventId}`;
  const stored = storage.getItem(key);
  const prior = Number(stored);
  if (stored !== null && Number.isFinite(prior) && now - prior < CLAIM_TTL_MS) return false;
  storage.setItem(key, String(now));
  return true;
}

export async function withConflictAlertClaim(eventId: string, show: () => void): Promise<void> {
  const locks = navigator.locks;
  if (locks) {
    await locks.request(`openfloor-conflict-alert:${eventId}`, { ifAvailable: true }, (lock) => {
      if (lock && claimConflictAlert(window.localStorage, eventId)) show();
    });
    return;
  }
  if (claimConflictAlert(window.localStorage, eventId)) show();
}

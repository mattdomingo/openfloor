import { getDb } from "./index";

// Warm sandbox pool bookkeeping. A pool entry is one run container that stays
// alive between runs of the same repository so the next run skips the cold
// start and inherits the npm cache. Claims use a guarded UPDATE so two
// concurrent workflows can never take the same entry; the loser inserts a
// fresh one. Publisher sandboxes are never pooled.

// Idle containers bill for memory/disk, so the idle TTL is the cost lever.
export const POOL_IDLE_TTL_MS = 15 * 60 * 1000;
// A claim older than this belongs to a workflow that died without releasing;
// the sweep destroys the container rather than trusting its state.
export const POOL_ABANDONED_CLAIM_MS = 2 * 60 * 60 * 1000;

export async function claimPoolSandbox(repositoryId: string, runId: string, database = getDb()): Promise<string> {
  const now = Date.now();
  // Prefer the most recently used entry — it is the warmest.
  const claimed = await database.prepare(
    `UPDATE sandbox_pool SET state = 'claimed', claimed_by_run_id = ?2, last_used_at = ?3
     WHERE id = (SELECT id FROM sandbox_pool WHERE repository_id = ?1 AND state = 'idle' ORDER BY last_used_at DESC LIMIT 1)
       AND state = 'idle'
     RETURNING id`,
  ).bind(repositoryId, runId, now).first<{ id: string }>();
  if (claimed) return claimed.id;
  const id = `pool-${crypto.randomUUID()}`;
  await database.prepare(
    "INSERT INTO sandbox_pool (id, repository_id, state, claimed_by_run_id, last_used_at, created_at) VALUES (?, ?, 'claimed', ?, ?, ?)",
  ).bind(id, repositoryId, runId, now, now).run();
  return id;
}

export async function releasePoolSandbox(sandboxId: string, database = getDb()): Promise<void> {
  await database.prepare(
    "UPDATE sandbox_pool SET state = 'idle', claimed_by_run_id = NULL, last_used_at = ? WHERE id = ? AND state = 'claimed'",
  ).bind(Date.now(), sandboxId).run();
}

// Used when the between-run reset fails: the container is destroyed instead of
// returned to the pool, and the row must not offer it to anyone else.
export async function retirePoolSandbox(sandboxId: string, database = getDb()): Promise<void> {
  await database.prepare("DELETE FROM sandbox_pool WHERE id = ?").bind(sandboxId).run();
}

// Marks evictable entries as draining and returns them; the caller destroys
// the containers and then deletes the rows. Draining (not deleting) first
// keeps a crashed sweep from stranding a billed container with no record.
export async function takeEvictablePoolSandboxes(database = getDb()): Promise<string[]> {
  const now = Date.now();
  const rows = await database.prepare(
    `UPDATE sandbox_pool SET state = 'draining'
     WHERE (state = 'idle' AND last_used_at < ?1) OR (state = 'claimed' AND last_used_at < ?2) OR state = 'draining'
     RETURNING id`,
  ).bind(now - POOL_IDLE_TTL_MS, now - POOL_ABANDONED_CLAIM_MS).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

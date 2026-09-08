import { getDb } from "@/db";
import { notifyFloorChanged } from "./presence-server";
import { pokeSessionRouter } from "./router-server";

/** Identity changes affect queued prompts in every live room authored by this user. */
export async function notifyGitHubVerification(userId: string) {
  const database = getDb();
  const rows = await database.prepare(
    `UPDATE sessions SET floor_revision = floor_revision + 1 WHERE ended_at IS NULL
     AND id IN (SELECT q.session_id FROM floor_queue_items q JOIN floor_queue_prompts p ON p.queue_item_id = q.id
                WHERE p.author_user_id = ? AND q.dismissed_at IS NULL)
     RETURNING id, floor_revision AS revision`,
  ).bind(userId).all<{ id: string; revision: number }>();
  await Promise.all(rows.results.map(async (row) => {
    await pokeSessionRouter(row.id, "agent_changed");
    await notifyFloorChanged(row.id, row.revision, ["queue", "runs", "review"]);
  }));
}

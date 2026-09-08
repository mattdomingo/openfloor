import { getDb } from "@/db";
import { notifyFloorChanged } from "./presence-server";
import { pokeSessionRouter } from "./router-server";

/** Account-owned changes invalidate the caller-specific floor in every live room. */
export async function notifyCredentialChange(userId: string) {
  const database = getDb();
  const sessions = await database.prepare(`SELECT s.id FROM sessions s JOIN session_members m ON m.session_id = s.id
    WHERE m.user_id = ? AND m.removed_at IS NULL AND s.ended_at IS NULL`).bind(userId).all<{ id: string }>();
  for (const session of sessions.results) {
    const row = await database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1 WHERE id = ? RETURNING floor_revision AS revision")
      .bind(session.id).first<{ revision: number }>();
    if (row) await notifyFloorChanged(session.id, row.revision, ["agents", "queue"]);
    await pokeSessionRouter(session.id, "toggle");
  }
}

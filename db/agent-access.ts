import { getDb, type D1DatabaseLike } from "./index";

/** Visibility is collaborative; spending authority is explicitly owner-granted. */
export async function canUseAgent(sessionId: string, agentId: string, userId: string, database: D1DatabaseLike = getDb()): Promise<boolean> {
  const row = await database.prepare(`SELECT 1 AS allowed FROM floor_agents a
    JOIN session_members owner ON owner.session_id = a.session_id AND owner.user_id = a.owner_user_id AND owner.removed_at IS NULL
    JOIN session_members caller ON caller.session_id = a.session_id AND caller.user_id = ? AND caller.removed_at IS NULL
    WHERE a.id = ? AND a.session_id = ? AND (a.owner_user_id = ? OR a.usage_scope = 'session')`)
    .bind(userId, agentId, sessionId, userId).first();
  return Boolean(row);
}

/** Re-read authorship and sharing at dispatch, including legacy merged groups. */
export async function queueAgentAccessError(sessionId: string, queueItemId: string, database: D1DatabaseLike = getDb()): Promise<string | null> {
  const row = await database.prepare(`SELECT a.owner_user_id AS ownerId, a.usage_scope AS scope, a.credential_kind AS kind,
      q.origin, q.source_run_id AS sourceRunId,
      EXISTS (SELECT 1 FROM agent_runs source WHERE source.id = q.source_run_id AND source.session_id = q.session_id AND source.agent_id = a.id) AS validSource,
      EXISTS (SELECT 1 FROM session_members m WHERE m.session_id = a.session_id AND m.user_id = a.owner_user_id AND m.removed_at IS NULL) AS ownerPresent,
      EXISTS (SELECT 1 FROM floor_queue_prompts p WHERE p.queue_item_id = q.id) AS hasPrompts,
      EXISTS (SELECT 1 FROM floor_queue_prompts p WHERE p.queue_item_id = q.id AND p.author_user_id <> a.owner_user_id) AS otherAuthors
    FROM floor_queue_items q JOIN floor_agents a ON a.id = q.agent_id AND a.session_id = q.session_id
    WHERE q.session_id = ? AND q.id = ? AND q.dismissed_at IS NULL`)
    .bind(sessionId, queueItemId).first<{ ownerId: string; scope: string; kind: string | null; origin: string | null; sourceRunId: string | null; validSource: number; ownerPresent: number; hasPrompts: number; otherAuthors: number }>();
  if (!row || !row.ownerPresent) return "The agent owner is no longer in this session.";
  if (row.kind === "oauth") return "Subscription connections are unavailable. The agent owner must select a connected API key.";
  if (row.origin) return row.validSource ? null : "System feedback must retain its source agent.";
  if (!row.hasPrompts || (row.scope !== "session" && row.otherAuthors)) return "This agent is private. Ask its owner to share it with the session.";
  return null;
}

export async function agentCredentialError(agentId: string, database: D1DatabaseLike = getDb()): Promise<string | null> {
  const row = await database.prepare(`SELECT a.credential_kind AS kind,
    EXISTS (SELECT 1 FROM user_provider_credentials c WHERE c.user_id = a.owner_user_id AND c.provider = a.provider AND c.kind = 'api_key') AS connected
    FROM floor_agents a JOIN session_members m ON m.session_id = a.session_id AND m.user_id = a.owner_user_id AND m.removed_at IS NULL WHERE a.id = ?`)
    .bind(agentId).first<{ kind: string | null; connected: number }>();
  if (row?.kind === "oauth") return "Subscription connections are unavailable. Select an API key in the agent settings.";
  return row?.connected ? null : "The agent owner must connect a personal API key in Settings. openfloor does not provide model usage.";
}

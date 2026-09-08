import { getDb } from "./index";
import { getMembershipRole } from "./sessions";
import { getQueueItemRunHistory } from "./runs";
import type { SessionPromptHistoryItem, SessionPromptHistoryPage } from "@/lib/floor-types";

const SELECT = `SELECT p.id, p.queue_item_id AS queueItemId, p.author_user_id AS authorUserId,
  u.display_name AS authorName, p.text, p.created_at AS createdAt, q.status, q.dismissed_at AS dismissedAt, q.origin,
  q.agent_id AS agentId, a.name AS agentName
  FROM floor_queue_prompts p JOIN floor_queue_items q ON q.id = p.queue_item_id
  JOIN users u ON u.id = p.author_user_id LEFT JOIN floor_agents a ON a.id = q.agent_id`;

export async function listSessionPromptHistory(sessionId: string, userId: string, filters: { before?: string | null; engineerId?: string | null; agentId?: string | null }, database = getDb()): Promise<SessionPromptHistoryPage | null> {
  if (!await getMembershipRole(sessionId, userId, database)) return null;
  if (filters.before && !await database.prepare("SELECT 1 FROM floor_queue_prompts p JOIN floor_queue_items q ON q.id = p.queue_item_id WHERE p.id = ? AND q.session_id = ?").bind(filters.before, sessionId).first()) throw new Error("Invalid prompt cursor");
  const clauses = ["q.session_id = ?"];
  const values: string[] = [sessionId];
  if (filters.before) { clauses.push("(p.created_at, p.id) < (SELECT created_at, id FROM floor_queue_prompts WHERE id = ?)"); values.push(filters.before); }
  if (filters.engineerId) { clauses.push("p.author_user_id = ?"); values.push(filters.engineerId); }
  if (filters.agentId) { clauses.push("EXISTS (SELECT 1 FROM agent_runs r WHERE r.queue_item_id = q.id AND r.agent_id = ?) OR q.agent_id = ?"); values.push(filters.agentId, filters.agentId); }
  const [rows, engineers, agents] = await Promise.all([
    database.prepare(`${SELECT} WHERE ${clauses.map((clause) => `(${clause})`).join(" AND ")} ORDER BY p.created_at DESC, p.id DESC LIMIT 26`).bind(...values).all<SessionPromptHistoryItem>(),
    database.prepare("SELECT DISTINCT u.id, u.display_name AS name FROM floor_queue_prompts p JOIN floor_queue_items q ON q.id = p.queue_item_id JOIN users u ON u.id = p.author_user_id WHERE q.session_id = ? ORDER BY name, u.id").bind(sessionId).all<{ id: string; name: string }>(),
    database.prepare("SELECT DISTINCT a.id, a.name FROM floor_agents a WHERE a.session_id = ? AND (EXISTS (SELECT 1 FROM floor_queue_items q WHERE q.agent_id = a.id) OR EXISTS (SELECT 1 FROM agent_runs r WHERE r.agent_id = a.id)) ORDER BY a.name, a.id").bind(sessionId).all<{ id: string; name: string }>(),
  ]);
  const items = rows.results.slice(0, 25);
  return { items, nextCursor: rows.results.length > 25 ? items[24].id : null, engineers: engineers.results, agents: agents.results };
}

export async function getSessionPromptHistory(sessionId: string, userId: string, promptId: string, before: string | null, database = getDb()) {
  if (!await getMembershipRole(sessionId, userId, database)) return null;
  const prompt = await database.prepare(`${SELECT} WHERE p.id = ? AND q.session_id = ?`).bind(promptId, sessionId).first<SessionPromptHistoryItem>();
  if (!prompt) return null;
  if (before && !await database.prepare("SELECT 1 FROM agent_runs WHERE id = ? AND queue_item_id = ? AND session_id = ?").bind(before, prompt.queueItemId, sessionId).first()) throw new Error("Invalid run cursor");
  return { prompt, ...await getQueueItemRunHistory(prompt.queueItemId, sessionId, before, database) };
}

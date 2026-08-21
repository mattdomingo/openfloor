import { MAX_SKILLS_PER_SESSION, type ParsedSkill } from "@/lib/skill-validation";
import { getDb, type D1DatabaseLike } from "./index";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";

export class SkillLimitError extends Error {}

export type SessionSkillSummary = {
  id: string;
  name: string;
  description: string;
  contentLength: number;
  updatedAt: number;
};

const SUMMARY_COLUMNS = "id, name, description, LENGTH(content) AS contentLength, updated_at AS updatedAt";

// Members can read the skill list (same visibility rule as repository
// details); only the owner mutates. Non-members get null → 404 concealment.
export async function listSessionSkillsForMember(
  sessionId: string,
  userId: string,
  database: D1DatabaseLike = getDb(),
): Promise<SessionSkillSummary[] | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const rows = await database
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM session_skills WHERE session_id = ? ORDER BY name`)
    .bind(sessionId)
    .all<SessionSkillSummary>();
  return rows.results.map((row) => ({ ...row, contentLength: Number(row.contentLength) }));
}

export async function upsertSessionSkill(
  sessionId: string,
  userId: string,
  skill: ParsedSkill,
  database: D1DatabaseLike = getDb(),
): Promise<SessionSkillSummary[] | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const existing = await database
    .prepare("SELECT id FROM session_skills WHERE session_id = ? AND name = ?")
    .bind(sessionId, skill.name)
    .first<{ id: string }>();
  if (!existing) {
    const count = await database
      .prepare("SELECT COUNT(*) AS count FROM session_skills WHERE session_id = ?")
      .bind(sessionId)
      .first<{ count: number }>();
    if (Number(count?.count ?? 0) >= MAX_SKILLS_PER_SESSION) {
      throw new SkillLimitError(`A session can hold at most ${MAX_SKILLS_PER_SESSION} skills.`);
    }
  }
  const now = Date.now();
  await database
    .prepare(
      `INSERT INTO session_skills (id, session_id, name, description, content, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, name) DO UPDATE SET
         description = excluded.description,
         content = excluded.content,
         updated_at = excluded.updated_at`,
    )
    .bind(crypto.randomUUID(), sessionId, skill.name, skill.description, skill.content, userId, now, now)
    .run();
  return listSessionSkillsForMember(sessionId, userId, database);
}

export async function deleteSessionSkill(
  sessionId: string,
  userId: string,
  skillId: string,
  database: D1DatabaseLike = getDb(),
): Promise<SessionSkillSummary[] | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  await database
    .prepare("DELETE FROM session_skills WHERE session_id = ? AND id = ?")
    .bind(sessionId, skillId)
    .run();
  return listSessionSkillsForMember(sessionId, userId, database);
}

// Full contents for run materialization (internal — no membership check; the
// workflow acts on a run the owner already authorized).
export async function getSessionSkillsForRun(
  sessionId: string,
  database: D1DatabaseLike = getDb(),
): Promise<Array<{ name: string; content: string }>> {
  const rows = await database
    .prepare("SELECT name, content FROM session_skills WHERE session_id = ? ORDER BY name")
    .bind(sessionId)
    .all<{ name: string; content: string }>();
  return rows.results;
}

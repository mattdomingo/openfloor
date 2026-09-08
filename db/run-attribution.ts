import { getDb } from "./index";
import { readGitHubIdentity } from "@/lib/github-identity";
import { readRunAttribution, type RunAuthor, type RunAttribution } from "@/lib/run-attribution";

export class GitHubVerificationRequiredError extends Error {}

/** Prompt authorship, never the owner who dispatched the run, determines credit. */
export async function getQueueRunAttribution(sessionId: string, queueItemId: string, requireVerified: boolean, database = getDb()): Promise<RunAttribution> {
  const rows = await database.prepare(
    `SELECT p.author_user_id AS userId, u.display_name AS name, u.verified_github AS identity, q.origin
     FROM floor_queue_items q JOIN floor_queue_prompts p ON p.queue_item_id = q.id JOIN users u ON u.id = p.author_user_id
     WHERE q.id = ? AND q.session_id = ? ORDER BY p.created_at, p.id`,
  ).bind(queueItemId, sessionId).all<{ userId: string; name: string; identity: string | null; origin: string | null }>();
  if (rows.results[0]?.origin) return { kind: "system", authors: [] };
  const missing = [...new Set(rows.results.filter((row) => !readGitHubIdentity(row.identity)).map((row) => row.name))];
  if (requireVerified && (missing.length || !rows.results.length)) {
    throw new GitHubVerificationRequiredError(`GitHub verification required for ${missing.join(", ") || "prompt authors"}. Open Settings → Connections and refresh GitHub access.`);
  }
  const authors = new Map<string, RunAttribution["authors"][number]>();
  for (const row of rows.results) {
    const identity = readGitHubIdentity(row.identity);
    if (identity && !authors.has(identity.id)) authors.set(identity.id, { userId: row.userId, githubId: identity.id, login: identity.login });
  }
  return { kind: "human", authors: [...authors.values()] };
}

/** Entire candidate audit, independent of the floor's latest-20 window and live membership. */
export async function getCandidateCommitAuthors(sessionId: string, candidateId: string, database = getDb()): Promise<RunAuthor[]> {
  const rows = await database.prepare(
    `SELECT r.attribution,
       (SELECT json_group_array(json_object('userId', p.author_user_id, 'identity', u.verified_github))
        FROM floor_queue_prompts p JOIN users u ON u.id = p.author_user_id WHERE p.queue_item_id = r.queue_item_id
        ORDER BY p.created_at, p.id) AS legacyAuthors
     FROM agent_runs r JOIN floor_queue_items q ON q.id = r.queue_item_id AND q.session_id = r.session_id
     WHERE r.session_id = ? AND r.candidate_id = ? AND r.status = 'integrated' AND r.kind IS NULL AND q.origin IS NULL
       AND EXISTS (SELECT 1 FROM agent_run_files f WHERE f.run_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM agent_run_rollbacks rb WHERE rb.run_id = r.id AND rb.status = 'completed')
     ORDER BY r.integrated_at, r.id`,
  ).bind(sessionId, candidateId).all<{ attribution: string | null; legacyAuthors: string }>();
  const authors = new Map<string, RunAuthor>();
  for (const row of rows.results) {
    const snapshot = readRunAttribution(row.attribution);
    const legacy = snapshot ? [] : (JSON.parse(row.legacyAuthors) as Array<{ userId: string; identity: string | null }>).flatMap((person) => {
      const identity = readGitHubIdentity(person.identity);
      return identity ? [{ userId: person.userId, githubId: identity.id, login: identity.login }] : [];
    });
    for (const author of snapshot?.authors ?? legacy) if (!authors.has(author.githubId)) authors.set(author.githubId, author);
  }
  return [...authors.values()];
}

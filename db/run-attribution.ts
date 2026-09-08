import { getDb } from "./index";
import { readGitHubIdentity } from "@/lib/github-identity";
import type { RunAttribution } from "@/lib/run-attribution";

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

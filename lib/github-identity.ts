/** Public identity proven by GitHub's authenticated /user endpoint. */
export type GitHubIdentity = { id: string; login: string; verifiedAt: number };

export function parseGitHubIdentity(value: unknown): GitHubIdentity | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<GitHubIdentity>;
  if (typeof row.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(row.id) ||
      typeof row.login !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(row.login) ||
      !Number.isSafeInteger(row.verifiedAt) || row.verifiedAt! <= 0) return null;
  return { id: row.id, login: row.login, verifiedAt: row.verifiedAt! };
}

export function readGitHubIdentity(json: string | null | undefined): GitHubIdentity | null {
  try { return parseGitHubIdentity(JSON.parse(json ?? "null")); } catch { return null; }
}

export async function verifyGitHubProfile(token: string): Promise<{ identity: GitHubIdentity; name: string | null }> {
  const response = await fetch("https://api.github.com/user", { headers: {
    accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "openfloor",
  } });
  const profile = response.ok ? await response.json().catch(() => null) as { id?: number; login?: string; type?: string; name?: string | null } | null : null;
  const identity = profile && Number.isSafeInteger(profile.id) && profile.type === "User"
    ? parseGitHubIdentity({ id: String(profile.id), login: profile.login, verifiedAt: Date.now() }) : null;
  if (!identity) throw new Error("GitHub identity could not be verified. Existing connections were preserved.");
  return { identity, name: typeof profile?.name === "string" ? profile.name : null };
}

export function githubCommitEmail(identity: Pick<GitHubIdentity, "id" | "login">): string {
  return `${identity.id}+${identity.login}@users.noreply.github.com`;
}

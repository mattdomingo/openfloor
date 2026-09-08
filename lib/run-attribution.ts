import { parseGitHubIdentity } from "./github-identity";

export type RunAuthor = { userId: string; githubId: string; login: string };
export type RunAttribution = { kind: "human" | "system"; authors: RunAuthor[] };
export type RunRequester = { userId: string; name: string; deleted: boolean };

export function readRunAttribution(json: string | null | undefined): RunAttribution | null {
  if (!json) return null;
  const value = JSON.parse(json) as RunAttribution;
  if (!value || !["human", "system"].includes(value.kind) || !Array.isArray(value.authors) ||
      value.authors.some((author) => typeof author.userId !== "string" || !parseGitHubIdentity({ id: author.githubId, login: author.login, verifiedAt: 1 })) ||
      (value.kind === "system" && value.authors.length > 0)) throw new Error("Invalid stored run attribution");
  return value;
}

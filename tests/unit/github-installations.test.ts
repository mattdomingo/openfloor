import { describe, expect, it } from "vitest";
import { deduplicateAccountGitHubRepositories } from "@/lib/account-github-repositories";

function repository(id: string, fullName: string, accountInstallationId: string) {
  const [owner, name] = fullName.split("/");
  return {
    id,
    nodeId: `node-${id}`,
    owner,
    name,
    fullName,
    private: true,
    defaultBranch: "main",
    accountInstallationId,
  };
}

describe("account GitHub repository options", () => {
  it("deduplicates repositories across installations and keeps a server-issued association", () => {
    expect(deduplicateAccountGitHubRepositories([
      repository("2", "zeta/service", "association-zeta"),
      repository("1", "acme/app", "association-first"),
      repository("1", "acme/app", "association-duplicate"),
    ])).toEqual([
      repository("1", "acme/app", "association-first"),
      repository("2", "zeta/service", "association-zeta"),
    ]);
  });
});

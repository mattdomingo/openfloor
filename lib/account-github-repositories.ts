import type { AccountGitHubRepositoryOption } from "./session-types";

export function deduplicateAccountGitHubRepositories(
  options: AccountGitHubRepositoryOption[],
): AccountGitHubRepositoryOption[] {
  const byRepositoryId = new Map<string, AccountGitHubRepositoryOption>();
  for (const option of options) {
    if (!byRepositoryId.has(option.id)) byRepositoryId.set(option.id, option);
  }
  return [...byRepositoryId.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

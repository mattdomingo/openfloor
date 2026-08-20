import type { RepositoryCandidate, RepositoryConnection } from "./session-types";

// The agent floor needs a repository that's both connected and execution-enabled
// (an active candidate branch exists) so agents have somewhere to make changes.
export function isRepositoryReadyForFloor(
  repository: RepositoryConnection | null,
  candidate: RepositoryCandidate | null,
): boolean {
  if (!repository || !candidate) return false;
  return repository.status !== "disconnected" && repository.status !== "revoked" && repository.status !== "inaccessible";
}

import type { Plan, PlanStatus } from "./plans";
import type { CredentialProvider } from "./provider-credentials";

export type SessionRole = "owner" | "member";

export type SessionSummary = {
  id: string;
  title: string;
  objective: string | null;
  role: SessionRole;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
  objectiveUpdatedAt: number;
  endedAt: number | null;
  endedReason: "owner" | "merged" | null;
  archivedAt: number | null;
  activeSeconds: number;
  autoProvisionAgents: boolean;
  autoAgentProvider: CredentialProvider | null;
  // Reversible door-seal: null means new joins are accepted. Distinct from
  // endedAt, which is terminal and makes the floor read-only for everyone.
  lockedAt: number | null;
};

export type SessionMember = {
  id: string;
  displayName: string;
  role: SessionRole;
  joinedAt: number;
  online: boolean;
};

// Owner-only audit view of a soft-deleted member. Their chat and queue
// prompts remain as session history; only this row's removed_at/removed_by
// (and their transferred agent ownership) reflect the removal.
export type RemovedSessionMember = {
  id: string;
  displayName: string;
  removedAt: number;
};

export type TypingDraft = {
  userId: string;
  displayName: string;
  text: string;
  typing: boolean;
  updatedAt: number;
};

export type TypingUpdate = {
  type: "typing.update";
  text: string;
  typing: boolean;
};

export type PresenceEvent =
  | { type: "presence.snapshot"; onlineUserIds: string[]; typingDrafts: TypingDraft[] }
  | { type: "presence.changed"; userId: string; online: boolean }
  | { type: "typing.changed"; draft: TypingDraft }
  | { type: "members.changed" }
  | { type: "session.changed"; objective: string | null; updatedAt: number }
  | { type: "session.ended"; endedAt: number; reason: "owner" | "merged" }
  | { type: "session.locked"; lockedAt: number | null }
  | { type: "floor.changed"; revision: number; domains: import("./floor-types").FloorDomain[] }
  | { type: "run.activity"; runId: string; agentId: string; events: import("./floor-types").RunActivityEvent[] }
  | { type: "error"; code: string };

export type AppUser = {
  id: string;
  providerUserId: string;
  email: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  githubHandle: string | null;
  avatarKey: string | null;
  onboardedAt: number | null;
  doNotDisturb: boolean;
  plan: Plan;
  planStatus: PlanStatus;
  seatLimit: number | null;
  createdAt: number;
  updatedAt: number;
  // Tombstone set only by deleteAccount; see db/schema.ts's users.deletedAt
  // comment. Not used to filter reads — a live AppUser is never expected to
  // have this set.
  deletedAt: number | null;
};

export type RepositoryConnectionStatus = "connected" | "ready" | "revoked" | "inaccessible" | "externally_modified" | "disconnected";

export type RepositoryCandidate = {
  id: string;
  sessionId: string;
  connectionId: string;
  name: string;
  description: string;
  branchName: string;
  baseBranch: string;
  baseSha: string;
  candidateSha: string | null;
  remoteBaseSha: string | null;
  remoteCandidateSha: string | null;
  integrationRunId: string | null;
  pullRequestNumber: number | null;
  pullRequestNodeId: string | null;
  pullRequestUrl: string | null;
  pullRequestState: "open" | "closed" | null;
  pullRequestDraft: boolean | null;
  pullRequestMerged: boolean | null;
  pullRequestMergeable: boolean | null;
  pullRequestMergeableState: string | null;
  githubChecksPassing: boolean | null;
  reviewReadyAt: number | null;
  reviewSyncedAt: number | null;
  mergeCommitSha: string | null;
  mergedAt: number | null;
  cleanupStatus: "pending" | "complete" | "partial" | null;
  cleanupCompletedAt: number | null;
  branchDeletedAt: number | null;
  abandonedAt: number | null;
  status: "creating" | "active" | "merged" | "abandoned" | "creation_failed";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastSyncedAt: number | null;
  behindBase: boolean;
};

export type RepositoryPreflightStatus = "provisioning" | "running" | "passed" | "failed" | "cancelled" | "timed_out";

export type RepositoryPreflightCheck = {
  id: string;
  position: number;
  command: string;
  status: "pending" | "running" | "passed" | "failed" | "timed_out";
  exitCode: number | null;
  durationMs: number | null;
  outputExcerpt: string | null;
  hasLog: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type RepositoryPreflight = {
  id: string;
  sessionId: string;
  candidateId: string;
  candidateSha: string;
  status: RepositoryPreflightStatus;
  summary: string | null;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  checks: RepositoryPreflightCheck[];
};

export type RepositoryConnection = {
  id: string;
  sessionId: string;
  installationId: string;
  repositoryId: string;
  repositoryNodeId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  defaultBranch: string;
  baseBranch: string;
  status: RepositoryConnectionStatus;
  connectedBy: string;
  connectedAt: number;
  updatedAt: number;
  disconnectedAt: number | null;
};

export type GitHubRepositoryOption = {
  id: string;
  nodeId: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
};

export type UserGitHubInstallationSummary = {
  id: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "revoked";
  // How many of the installation's repositories this member's own GitHub
  // permissions reach (the stored repo_scope length); null for legacy
  // unscoped rows.
  repoCount: number | null;
  connectedAt: number;
  updatedAt: number;
};

export type AccountGitHubRepositoryOption = GitHubRepositoryOption & {
  accountInstallationId: string;
};

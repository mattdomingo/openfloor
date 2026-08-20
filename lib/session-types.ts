export type SessionRole = "owner" | "member";

export type SessionSummary = {
  id: string;
  title: string;
  objective: string | null;
  role: SessionRole;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  archivedAt: number | null;
};

export type SessionMember = {
  id: string;
  displayName: string;
  role: SessionRole;
  joinedAt: number;
  online: boolean;
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
  | { type: "session.ended"; endedAt: number }
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
  createdAt: number;
  updatedAt: number;
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
  status: "creating" | "active" | "merged" | "creation_failed";
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

export type RepositoryCheckCommand = {
  id: string;
  position: number;
  command: string;
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
  checkCommands: RepositoryCheckCommand[];
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

export type SessionRole = "owner" | "member";

export type SessionSummary = {
  id: string;
  title: string;
  objective: string | null;
  role: SessionRole;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
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
  | { type: "floor.changed"; revision: number; domains: import("./floor-types").FloorDomain[] }
  | { type: "error"; code: string };

export type AppUser = {
  id: string;
  providerUserId: string;
  email: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
};

export type RepositoryConnectionStatus = "connected" | "disconnected";

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

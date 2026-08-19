import type { RepositoryCandidate, RepositoryConnection, RepositoryPreflight } from "./session-types";

export type FloorDomain = "agents" | "assignments" | "messages" | "queue" | "repository" | "runs" | "review";

export type FloorParticipant = {
  id: string;
  name: string;
  initials: string;
  tone: string;
  role: "owner" | "member";
  online: boolean;
  isCurrentUser: boolean;
};

export type FloorAgentState = "created";

export type FloorAgent = {
  id: string;
  name: string;
  role: string;
  task: string;
  ownerUserId: string;
  ownerName: string;
  createdByUserId: string;
  state: FloorAgentState;
  createdAt: number;
  updatedAt: number;
};

export type FloorAssignment = {
  userId: string;
  userName: string;
  task: string | null;
  updatedByUserId: string | null;
  updatedAt: number | null;
};

export type FloorMessage = {
  id: string;
  authorUserId: string;
  authorName: string;
  recipientUserId: string | null;
  text: string;
  createdAt: number;
};

export type FloorQueuePrompt = {
  id: string;
  authorUserId: string;
  authorName: string;
  text: string;
  createdAt: number;
};

export type FloorQueueItem = {
  id: string;
  agentId: string | null;
  agentName: string | null;
  position: number;
  status: "queued" | "running" | "blocked" | "completed";
  prompts: FloorQueuePrompt[];
  createdAt: number;
  updatedAt: number;
};

export type AgentRunStatus = "provisioning" | "running" | "checking" | "ready" | "publishing" | "published" | "integrating" | "integrated" | "conflicted" | "failed" | "cancel_requested" | "cancelled";

export type AgentRunCheck = {
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

export type AgentRunFile = {
  id: string;
  path: string;
  changeKind: "add" | "update" | "delete";
  additions: number;
  deletions: number;
  summary: string | null;
  diffPreview: string;
};

export type AgentRun = {
  id: string;
  queueItemId: string;
  agentId: string;
  agentName: string;
  candidateId: string;
  candidateSha: string;
  runBranch: string | null;
  localCommitSha: string | null;
  runCommitSha: string | null;
  remoteRunSha: string | null;
  attempt: number;
  status: AgentRunStatus;
  model: string;
  summary: string | null;
  finalResponse: string | null;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  publishedAt: number | null;
  integrationBaseSha: string | null;
  integratedCandidateSha: string | null;
  conflictReason: string | null;
  integrationStartedAt: number | null;
  integratedAt: number | null;
  discardedAt: number | null;
  cancelRequestedAt: number | null;
  updatedAt: number;
  checks: AgentRunCheck[];
  files: AgentRunFile[];
};

export type FloorReviewSnapshot = {
  id: string;
  status: "awaiting" | "changes-requested" | "approved";
  branch: string;
  baseBranch: string;
  commitSha: string | null;
  files: Array<{
    id: string;
    path: string;
    agentId: string | null;
    agentName: string | null;
    additions: number;
    deletions: number;
    summary: string | null;
    diff: Array<{ type: "context" | "add" | "remove"; text: string }>;
  }>;
  checks: Array<{ id: string; name: string; detail: string | null; state: "passed" | "waiting" | "failed" }>;
  warnings: Array<{ id: string; title: string; detail: string; severity: "conflict" | "warning" }>;
  updatedAt: number;
  pullRequest: { number: number; url: string; state: "open" | "closed"; draft: boolean } | null;
};

export type FloorSnapshot = {
  revision: number;
  agents: FloorAgent[];
  assignments: FloorAssignment[];
  messages: FloorMessage[];
  queue: FloorQueueItem[];
  repository: RepositoryConnection | null;
  activeCandidate: RepositoryCandidate | null;
  latestPreflight: RepositoryPreflight | null;
  runs: AgentRun[];
  review: FloorReviewSnapshot | null;
};

export type CreateFloorAgentInput = {
  name: string;
  role: string;
  task: string;
  ownerUserId: string;
};

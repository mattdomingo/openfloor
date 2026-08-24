import type { CredentialProvider } from "./provider-credentials";
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
  // Which agent provider runs for this agent execute on, and an optional
  // model override (null = the provider's default). Creation currently
  // always writes provider "openai" — selection UI is a later milestone.
  provider: CredentialProvider;
  model: string | null;
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
  status: "queued" | "running" | "blocked" | "completed" | "paused" | "failed" | "cancelled";
  assignedBy: "user" | "router" | null;
  assignedReason: string | null;
  prompts: FloorQueuePrompt[];
  createdAt: number;
  updatedAt: number;
};

export type AgentRunStatus = "provisioning" | "running" | "checking" | "ready" | "publishing" | "published" | "integrating" | "integrated" | "conflicted" | "failed" | "cancel_requested" | "cancelled";

export type RunActivityKind = "reasoning" | "command" | "file_edit" | "agent_message" | "tool_call" | "error" | "truncated";

export type RunActivityEvent = {
  id: string;
  runId: string;
  sequence: number;
  kind: string;
  detail: string;
  createdAt: number;
};

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
  branchDeletedAt: number | null;
  cancelRequestedAt: number | null;
  updatedAt: number;
  checks: AgentRunCheck[];
  files: AgentRunFile[];
};

export type ReviewContributor = {
  agentId: string;
  agentName: string;
  requestedBy: Array<{ userId: string; userName: string }>;
};

export type FloorReviewSnapshot = {
  id: string;
  status: "draft" | "ready" | "merged";
  branch: string;
  baseBranch: string;
  commitSha: string | null;
  files: Array<{
    id: string;
    path: string;
    contributors: ReviewContributor[];
    additions: number;
    deletions: number;
    summary: string | null;
    diff: Array<{ type: "context" | "add" | "remove"; text: string }>;
  }>;
  checks: Array<{ id: string; name: string; detail: string | null; state: "passed" | "waiting" | "failed" }>;
  warnings: Array<{ id: string; title: string; detail: string; severity: "conflict" | "warning" }>;
  updatedAt: number;
  githubChecksPassing: boolean | null;
  cleanupStatus: "pending" | "complete" | "partial" | null;
  branchDeletedAt: number | null;
  integrationRunId: string | null;
  pullRequest: {
    number: number;
    url: string;
    state: "open" | "closed";
    draft: boolean;
    merged: boolean;
    mergeable: boolean | null;
    mergeableState: string | null;
  } | null;
};

export type FloorSnapshot = {
  revision: number;
  autoDispatch: boolean;
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
  // Omitted means "openai" (the historical behavior); the dialog only offers
  // a choice while the Claude rollout gate is on.
  provider?: CredentialProvider;
};

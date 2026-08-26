import type { CredentialKind, CredentialProvider } from "./provider-credentials";
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

// Null means a persistent user-created agent. System-managed agents are
// activated and deactivated by the router: "answer" is the concierge and
// "worker" handles code tasks.
export type FloorAgentKind = "answer" | "worker" | null;

export type FloorAgent = {
  id: string;
  name: string;
  role: string;
  task: string;
  ownerUserId: string;
  ownerName: string;
  createdByUserId: string;
  state: FloorAgentState;
  kind: FloorAgentKind;
  // Which agent provider runs for this agent execute on, and an optional
  // model override (null = the provider's default). The create-agent dialog
  // writes both, the model from PROVIDER_MODELS' closed per-provider list.
  provider: CredentialProvider;
  model: string | null;
  // Which of the owner's credential kinds this agent's runs bill (null = the
  // owner's default). Member-visible on purpose: this is the agent's own
  // stored choice, made in a dialog every member can open — NOT the owner's
  // connection state, which stays private (the rule that forbids revealing
  // which kinds an owner has connected is about their account, not the
  // agent). Showing it is what makes the "connect it or change the agent"
  // run refusal diagnosable, so do not "fix" this back to hidden.
  credentialKind: CredentialKind | null;
  // Manual pause/stop state for a persistent agent (kind === null). Non-null
  // blocks new router assignment/dispatch; an in-flight run finishes
  // normally. Always null for a system-managed agent.
  pausedAt: number | null;
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

// Classified by db/routing.ts's classifyPrompt. Null means classified before
// this column existed, or not yet visited by a routing tick; treat as "task".
export type PromptIntent = "task" | "question" | "noise";

export type FloorQueueItem = {
  id: string;
  agentId: string | null;
  agentName: string | null;
  position: number;
  status: "queued" | "running" | "blocked" | "completed" | "paused" | "failed" | "cancelled";
  assignedBy: "user" | "router" | null;
  assignedReason: string | null;
  intent: PromptIntent | null;
  prompts: FloorQueuePrompt[];
  createdAt: number;
  updatedAt: number;
};

export type AgentRunStatus = "provisioning" | "running" | "checking" | "ready" | "publishing" | "published" | "integrating" | "integrated" | "conflicted" | "failed" | "cancel_requested" | "cancelled";

// Null means an ordinary task run that publishes and integrates. "reply" is a
// read-only run that answers a question/non-actionable prompt — see
// agent_runs.kind in db/schema.ts for the full invariant.
export type AgentRunKind = "reply" | null;

export type AgentRunRollbackStatus = "requested" | "running" | "completed" | "failed";

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
  kind: AgentRunKind;
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
  purpose: "task" | "conflict_resolution";
  conflictCaseId: string | null;
  rollbackId: string | null;
  rollbackStatus: AgentRunRollbackStatus | null;
  rollbackExpectedCandidateSha: string | null;
  rollbackCommitSha: string | null;
  rollbackFailureReason: string | null;
  rollbackBy: string | null;
  rollbackRequestedAt: number | null;
  rollbackCompletedAt: number | null;
  checks: AgentRunCheck[];
  files: AgentRunFile[];
};

export type MergeConflictStatus = "pending" | "resolving" | "awaiting_input" | "resolved" | "failed";

export type MergeConflictQuestion = {
  id: string;
  question: string;
  answer: string | null;
  answeredByUserId: string | null;
  answeredByName: string | null;
  requestedAt: number;
  answeredAt: number | null;
};

export type MergeConflictCase = {
  id: string;
  status: MergeConflictStatus;
  sourceRunId: string;
  latestSourceRunId: string;
  currentResolverRunId: string | null;
  queueItemId: string;
  agentId: string;
  agentName: string;
  conflictReason: string;
  explanation: string | null;
  conflictPaths: string[];
  automaticAttempts: number;
  failureReason: string | null;
  questions: MergeConflictQuestion[];
  prompts: Array<{ id: string; authorUserId: string; authorName: string; text: string }>;
  attempts: Array<{
    runId: string;
    launchKind: "automatic" | "manual" | "answer";
    status: AgentRunStatus;
    summary: string | null;
    createdAt: number;
    completedAt: number | null;
    checks: Array<{ command: string; status: AgentRunCheck["status"] }>;
  }>;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
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
  conflicts: MergeConflictCase[];
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
  autoProvisionAgents: boolean;
  autoAgentProvider: CredentialProvider | null;
  effectiveAutoAgentProvider: CredentialProvider | null;
  autoAgentProviderState: "selected" | "single_connected" | "openai_fallback" | "selection_required";
  autoResolveConflicts: boolean;
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
  // Omitted means "openai" (the historical behavior); the dialog offers a
  // choice whenever more than one provider's rollout flag is enabled.
  provider?: CredentialProvider;
  // Which of the owner's credential kinds pays for this agent's runs.
  // Omitted/null means "the owner's default"; the dialog offers the choice
  // only for providers that accept more than one kind.
  credentialKind?: CredentialKind | null;
  // Omitted/null means "the provider's default"; must be one of
  // PROVIDER_MODELS[provider], enforced server-side in parseAgentInput.
  model?: string | null;
};

// Partial edit of an existing persistent agent (PATCH .../agents/[agentId]).
// Omitted = leave alone; explicit null = reset to the default. model and
// credentialKind are validated server-side against the agent's STORED
// provider, never a client-supplied one.
export type FloorAgentSettingsPatch = {
  task?: string;
  model?: string | null;
  credentialKind?: CredentialKind | null;
};

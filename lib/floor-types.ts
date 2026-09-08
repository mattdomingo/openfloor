import type { ConflictChoice, ConflictHunk } from "./conflict-hunks";
import type { CredentialKind, CredentialProvider } from "./provider-credentials";
import type { RepositoryCandidate, RepositoryConnection, RepositoryPreflight } from "./session-types";

export type { ConflictChoice, ConflictHunk };

export type FloorDomain = "agents" | "assignments" | "messages" | "queue" | "repository" | "runs" | "review" | "preview";

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
  // blocks new run dispatch; an in-flight run finishes normally. Always null
  // for a system-managed agent.
  pausedAt: number | null;
  // Lifetime spend across every run this agent has made (db/floor.ts sums
  // agent_runs.cost_micro_usd). Null means no priced run yet — an agent with
  // no runs, or whose only runs used an unpriced model. "mixed" covers an
  // agent whose model crossed the anthropic/kimi/glm reported/estimated
  // boundary mid-life (lib/run-usage.ts). billedKind reflects the most
  // recent run's resolved credential, not an aggregate — "who pays now."
  costMicroUsd: number | null;
  costSource: "reported" | "estimated" | "mixed" | null;
  billedKind: "api_key" | "oauth" | "server" | null;
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

// A file a member shared into the session (ENG-113). messageId links it to
// the team-chat message it was attached to; null means it went straight to
// the artifacts area (composer attachments included). Bytes are served by
// GET /api/sessions/[id]/files/[fileId]; this row is what authorizes that.
export type SessionFile = {
  id: string;
  uploadedByUserId: string;
  uploadedByName: string;
  messageId: string | null;
  name: string;
  contentType: string;
  sizeBytes: number;
  createdAt: number;
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
  githubVerified?: boolean;
  id: string;
  authorUserId: string;
  authorName: string;
  text: string;
  createdAt: number;
};

// Classified by db/routing.ts's classifyPrompt. Null means classified before
// this column existed, or not yet visited by a routing tick; treat as "task".
export type PromptIntent = "task" | "question" | "noise";

// Why a system-originated queue item exists; null for human-authored items.
// The kinds are PR feedback nudges — see lib/pr-feedback.ts.
export type QueueItemOrigin = "ci_failure" | "review_comments" | "changes_requested";

// A question/noise item's reply text, kept on the queue item itself (sourced
// from its own most recent reply run) rather than only reachable by matching
// FloorSnapshot.runs by queueItemId — that array is capped at 20 rows and the
// answering agent (often a retiring Concierge) may no longer be on the floor.
export type QueueItemAnswer = {
  runId: string;
  agentId: string | null;
  agentName: string;
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
  intent: PromptIntent | null;
  origin: QueueItemOrigin | null;
  rollback: QueueRollbackDescriptor | null;
  answer: QueueItemAnswer | null;
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
export type AgentRunRollbackScope = "prompt" | "engineer" | "agent";

export type QueueRollbackDescriptor = {
  runId: string;
  status: AgentRunRollbackStatus | null;
  failureReason: string | null;
  canStart: boolean;
};

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
  commitUrl?: string | null;
  attribution?: import("./run-attribution").RunAttribution | null;
  promptedBy?: import("./run-attribution").RunRequester[];
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
  completion?: "no_changes" | null;
  agentKind?: FloorAgentKind;
  model: string;
  summary: string | null;
  finalResponse: string | null;
  // Whole-run totals recorded at completion (lib/run-usage.ts); null for a
  // pre-feature run or a provider that reported nothing.
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  // Thread resume (lib/run-resume.ts): the earlier run whose provider thread
  // this run continued, its attempt number, and whether the provider
  // actually resumed (1), fell back to a fresh thread (0), or no resume was
  // attempted (null).
  resumedFromRunId: string | null;
  resumedFromAttempt: number | null;
  providerThreadResumed: number | null;
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
  resolution: import("./conflict-resolution").ConflictResolution | null;
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
  // Whether some resolver attempt on this case captured a conflict_snapshot
  // artifact — the manual resolver dialog needs at least one to have anything
  // to show. Cheap to derive alongside the rest of this row (an EXISTS join
  // in getMergeConflictCases), so the card can offer "Resolve manually"
  // without a round trip to fetch and parse the snapshot first.
  hasSnapshot: boolean;
};

// A single conflicted file from a resolver attempt's snapshot, already split
// into hunks server-side (lib/conflict-hunks.ts). "content" is the common
// case — real marker hunks in `hunks`. The three special kinds have exactly
// one synthetic hunk at index 0 representing a whole-file decision (no
// in-file markers exist to split): "delete_modify" (this side deleted it,
// the other modified it — choice is ours=delete/theirs=keep-their-content),
// "modify_delete" (the mirror), and "binary" (no text diff to show). A file
// that failed to parse (malformed markers) has `hunks: []` and
// `unparseable: true` — it stays visible in the file list but is not
// editable in this dialog.
export type ConflictFileKind = "content" | "delete_modify" | "modify_delete" | "binary";

export type ConflictFileSnapshot = {
  path: string;
  kind: ConflictFileKind;
  hunks: ConflictHunk[];
  unparseable: boolean;
  truncated: boolean;
};

export type ConflictSnapshot = {
  snapshotRunId: string;
  files: ConflictFileSnapshot[];
  // Paths recorded on the case but dropped from `files` by the snapshot's
  // own per-attempt cap (worker/agent-run-workflow.ts's MAX_SNAPSHOT_FILES) —
  // shown in the dialog as "N files too large to load for manual editing."
  omittedPaths: string[];
  existingSelections: Array<{ path: string; hunkIndex: number; choice: ConflictChoice }>;
};

export type ReviewContributor = {
  agentId: string;
  agentName: string;
  requestedBy: Array<{ userId: string; userName: string }>;
};

export type ReviewContributionPrompt = {
  authorDeleted?: boolean;
  id: string;
  authorUserId: string;
  authorName: string;
  text: string;
  createdAt: number;
};

export type ReviewContributionFile = {
  id: string;
  path: string;
  changeKind: AgentRunFile["changeKind"];
  additions: number;
  deletions: number;
  summary: string | null;
  diff?: Array<{ type: "context" | "add" | "remove"; text: string }>;
};

export type ReviewContribution = {
  attribution?: import("./run-attribution").RunAttribution | null;
  commitUrl?: string | null;
  runId: string;
  queueItemId: string;
  agentId: string;
  agentName: string;
  agentOwnerUserId: string;
  prompts: ReviewContributionPrompt[];
  files: ReviewContributionFile[];
  integratedAt: number;
  rollbackStatus: AgentRunRollbackStatus | null;
  rollbackFailureReason: string | null;
  canRollback: boolean;
};

export type ReviewContributorFacet = {
  id: string;
  name: string;
  activePromptGroups: number;
  activeFiles: number;
};

export type ReviewContributionPage = {
  items: ReviewContribution[];
  nextCursor: string | null;
  engineers: ReviewContributorFacet[];
  agents: ReviewContributorFacet[];
};

export type ReviewRollbackImpact = {
  scope: AgentRunRollbackScope;
  subjectId: string;
  subjectName: string;
  expectedCandidateSha: string;
  targets: ReviewContribution[];
  excluded: Array<ReviewContribution & { exclusionReason: string }>;
};

export type FloorReviewSnapshot = {
  id: string;
  status: "draft" | "ready" | "merged" | "abandoned";
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
  mergeLockedAt: number | null;
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
  autoInjectFeedback: boolean;
  agents: FloorAgent[];
  assignments: FloorAssignment[];
  messages: FloorMessage[];
  files: SessionFile[];
  queue: FloorQueueItem[];
  repository: RepositoryConnection | null;
  activeCandidate: RepositoryCandidate | null;
  latestPreflight: RepositoryPreflight | null;
  preview: RepositoryPreviewSnapshot | null;
  runs: AgentRun[];
  review: FloorReviewSnapshot | null;
};

export type RepositoryPreviewSnapshot = {
  status: "provisioning" | "ready" | "failed" | "expired";
  targetCandidateSha: string;
  activeCandidateSha: string | null;
  url: string | null;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  script: "dev" | "start" | null;
  failureReason: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
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

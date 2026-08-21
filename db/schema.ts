import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    providerUserId: text("chatgpt_user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    githubHandle: text("github_handle"),
    avatarKey: text("avatar_key"),
    onboardedAt: integer("onboarded_at"),
    doNotDisturb: integer("do_not_disturb", { mode: "boolean" }).notNull().default(false),
    // The purchased tier. Only meaningful while planStatus is "active" — see
    // effectivePlan() in lib/plans.ts, which is what every limit check
    // actually calls. Deliberately unchanged (enum, default) from when this
    // column had no planStatus alongside it: the "free" tier is a synthetic
    // TypeScript-only value effectivePlan returns, never stored here — that
    // keeps this an ADD-COLUMN-only migration (see 0019) instead of a table
    // recreate, which would cascade-delete session_members/session_invites/
    // github_connection_states (all ON DELETE CASCADE on users.id).
    plan: text("plan", { enum: ["pro", "max", "enterprise"] }).notNull().default("pro"),
    // Whether `plan` is currently paid for. Only "active" grants its plan's
    // limits; inactive (never purchased), past_due, and canceled all
    // resolve to free via effectivePlan(). New signups start inactive; a
    // manual grant sets plan + status together.
    planStatus: text("plan_status", { enum: ["inactive", "active", "past_due", "canceled"] })
      .notNull()
      .default("inactive"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // Tombstone marker set only by deleteAccount, not a soft-delete filter —
    // rows with this set are never queried against in normal reads; they
    // exist only so authored floor_messages/floor_agents/... rows in
    // sessions the deleted user did not own keep a valid FK target. Both
    // upsertUser lookups exclude it so the next sign-in with the same
    // identity creates a fresh row instead of resurrecting this one.
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("idx_users_chatgpt_user_id").on(table.providerUserId),
    // Email is the only identity signal stable across login methods (Access
    // issues a different chatgpt_user_id per IdP) — see 0022's merge
    // migration and upsertUser in db/sessions.ts, both of which depend on
    // this being unique and normalizeEmail (lib/identity.ts) keeping every
    // stored value lowercase and trimmed.
    uniqueIndex("idx_users_email").on(table.email),
    check("users_plan_check", sql`${table.plan} in ('pro', 'max', 'enterprise')`),
    check("users_plan_status_check", sql`${table.planStatus} in ('inactive', 'active', 'past_due', 'canceled')`),
  ],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  objective: text("objective"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  // Set only by updateSessionObjective, unlike updatedAt (which every floor
  // mutation bumps via bumpFloorRevision) — this is the one timestamp that
  // isolates "when the objective itself last changed" for the owner nudge.
  objectiveUpdatedAt: integer("objective_updated_at").notNull(),
  endedAt: integer("ended_at"),
  endedReason: text("ended_reason", { enum: ["owner", "merged"] }),
  floorRevision: integer("floor_revision").notNull().default(0),
  autoDispatch: integer("auto_dispatch", { mode: "boolean" }).notNull().default(false),
  // Display counter: seconds this session had at least one connected
  // participant. The billing ledger is usage_months; this one cascades away
  // with the session and that is fine.
  activeSeconds: integer("active_seconds").notNull().default(0),
  // Reversible door-seal: null means new joins are accepted. Set only by
  // setSessionLocked. Distinct from endedAt, which is terminal and makes the
  // floor read-only for everyone — locking leaves existing members and the
  // floor fully writable, and only gates acceptInvite.
  lockedAt: integer("locked_at"),
});

// Monthly active-presence seconds per session owner, the hour-quota ledger.
// Deliberately no foreign keys: usage must survive session (and user) purges.
export const usageMonths = sqliteTable(
  "usage_months",
  {
    ownerUserId: text("owner_user_id").notNull(),
    month: text("month").notNull(), // "YYYY-MM", UTC
    seconds: integer("seconds").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.ownerUserId, table.month] })],
);

export const sessionMembers = sqliteTable(
  "session_members",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    joinedAt: integer("joined_at").notNull(),
    archivedAt: integer("archived_at"),
    // Soft delete for owner-initiated removal: the row is kept (not
    // DELETEd) so acceptInvite can refuse the same person on a still-valid
    // invite link, and the owner has an audit trail (getRemovedSessionMembers)
    // to restore from. Null means active membership; every membership read
    // and write guard filters on this.
    removedAt: integer("removed_at"),
    // The removing owner's user id. No FK on purpose — same reasoning as
    // usage_months.ownerUserId: this audit field must not block or cascade
    // on a future user deletion.
    removedBy: text("removed_by"),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.userId] }),
    index("idx_session_members_user_id").on(table.userId),
    check("session_members_role_check", sql`${table.role} in ('owner', 'member')`),
  ],
);

export const sessionInvites = sqliteTable(
  "session_invites",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    index("idx_session_invites_session_id").on(table.sessionId),
    uniqueIndex("idx_session_invites_one_active")
      .on(table.sessionId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export const floorAgents = sqliteTable(
  "floor_agents",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull().references(() => users.id),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    role: text("role").notNull(),
    task: text("task").notNull(),
    state: text("state", { enum: ["created"] }).notNull(),
    // Open enum, TS-only, no SQL CHECK (agent_run_artifacts.kind convention);
    // existing rows keep current behavior via the default. `model` null means
    // "use the provider's default" (lib/provider-credentials.ts).
    provider: text("provider", { enum: ["anthropic", "openai"] }).notNull().default("openai"),
    model: text("model"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_floor_agents_session_name").on(table.sessionId, table.nameKey),
    index("idx_floor_agents_session_created").on(table.sessionId, table.createdAt),
    index("idx_floor_agents_owner").on(table.ownerUserId),
    check("floor_agents_state_check", sql`${table.state} in ('created')`),
  ],
);

export const floorAssignments = sqliteTable(
  "floor_assignments",
  {
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id),
    task: text("task"),
    updatedBy: text("updated_by").notNull().references(() => users.id),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.userId] }),
    index("idx_floor_assignments_updated_by").on(table.updatedBy),
  ],
);

export const floorMessages = sqliteTable(
  "floor_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull().references(() => users.id),
    recipientUserId: text("recipient_user_id").references(() => users.id),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_floor_messages_session_created").on(table.sessionId, table.createdAt),
    index("idx_floor_messages_recipient").on(table.recipientUserId),
  ],
);

export const floorQueueItems = sqliteTable(
  "floor_queue_items",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => floorAgents.id, { onDelete: "set null" }),
    position: integer("position").notNull(),
    status: text("status", { enum: ["queued", "running", "blocked", "completed", "paused", "failed", "cancelled"] }).notNull(),
    assignedBy: text("assigned_by", { enum: ["user", "router"] }),
    assignedReason: text("assigned_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_floor_queue_session_position").on(table.sessionId, table.position),
    index("idx_floor_queue_agent").on(table.agentId),
    check("floor_queue_status_check", sql`${table.status} in ('queued', 'running', 'blocked', 'completed', 'paused', 'failed', 'cancelled')`),
  ],
);

export const floorQueuePrompts = sqliteTable(
  "floor_queue_prompts",
  {
    id: text("id").primaryKey(),
    queueItemId: text("queue_item_id").notNull().references(() => floorQueueItems.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").notNull().references(() => users.id),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_floor_queue_prompts_item_created").on(table.queueItemId, table.createdAt)],
);

export const githubConnectionStates = sqliteTable(
  "github_connection_states",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    installationId: text("installation_id"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    configuredAt: integer("configured_at"),
  },
  (table) => [
    index("idx_github_connection_states_session_user").on(table.sessionId, table.userId, table.createdAt),
    index("idx_github_connection_states_expiry").on(table.expiresAt),
  ],
);

export const repositoryConnections = sqliteTable(
  "repository_connections",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    repositoryNodeId: text("repository_node_id").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    repositoryPrivate: integer("repository_private", { mode: "boolean" }).notNull(),
    defaultBranch: text("default_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    status: text("status", { enum: ["connected", "ready", "revoked", "inaccessible", "externally_modified", "disconnected"] }).notNull(),
    connectedBy: text("connected_by").notNull().references(() => users.id),
    connectedAt: integer("connected_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    disconnectedAt: integer("disconnected_at"),
  },
  (table) => [
    uniqueIndex("idx_repository_connections_one_per_session").on(table.sessionId),
    index("idx_repository_connections_installation").on(table.installationId),
    check("repository_connections_status_check", sql`${table.status} in ('connected', 'ready', 'revoked', 'inaccessible', 'externally_modified', 'disconnected')`),
  ],
);

export const repositoryCandidates = sqliteTable(
  "repository_candidates",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull().references(() => repositoryConnections.id),
    name: text("name").notNull().default(""),
    description: text("description").notNull().default(""),
    branchName: text("branch_name").notNull(),
    baseBranch: text("base_branch").notNull(),
    baseSha: text("base_sha").notNull(),
    candidateSha: text("candidate_sha"),
    remoteBaseSha: text("remote_base_sha"),
    remoteCandidateSha: text("remote_candidate_sha"),
    integrationRunId: text("integration_run_id"),
    pullRequestNumber: integer("pull_request_number"),
    pullRequestNodeId: text("pull_request_node_id"),
    pullRequestUrl: text("pull_request_url"),
    pullRequestState: text("pull_request_state", { enum: ["open", "closed"] }),
    pullRequestDraft: integer("pull_request_draft", { mode: "boolean" }),
    pullRequestMerged: integer("pull_request_merged", { mode: "boolean" }),
    pullRequestMergeable: integer("pull_request_mergeable", { mode: "boolean" }),
    pullRequestMergeableState: text("pull_request_mergeable_state"),
    githubChecksPassing: integer("github_checks_passing", { mode: "boolean" }),
    reviewReadyAt: integer("review_ready_at"),
    reviewReadyBy: text("review_ready_by").references(() => users.id),
    reviewSyncedAt: integer("review_synced_at"),
    mergeCommitSha: text("merge_commit_sha"),
    mergedAt: integer("merged_at"),
    mergedBy: text("merged_by").references(() => users.id),
    cleanupStatus: text("cleanup_status", { enum: ["pending", "complete", "partial"] }),
    cleanupCompletedAt: integer("cleanup_completed_at"),
    branchDeletedAt: integer("branch_deleted_at"),
    status: text("status", { enum: ["creating", "active", "creation_failed"] }).notNull(),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastSyncedAt: integer("last_synced_at"),
  },
  (table) => [
    index("idx_repository_candidates_session_created").on(table.sessionId, table.createdAt),
    uniqueIndex("idx_repository_candidates_one_live")
      .on(table.sessionId)
      .where(sql`${table.status} in ('creating', 'active') and ${table.mergedAt} is null`),
    uniqueIndex("idx_repository_candidates_branch").on(table.connectionId, table.branchName),
    check("repository_candidates_status_check", sql`${table.status} in ('creating', 'active', 'creation_failed')`),
  ],
);

export const repositoryCandidateFiles = sqliteTable(
  "repository_candidate_files",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id").notNull().references(() => repositoryCandidates.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    additions: integer("additions").notNull(),
    deletions: integer("deletions").notNull(),
    changeKind: text("change_kind", { enum: ["add", "update", "delete"] }).notNull(),
    patchPreview: text("patch_preview").notNull(),
  },
  (table) => [uniqueIndex("idx_repository_candidate_files_path").on(table.candidateId, table.path)],
);

export const repositoryCandidateChecks = sqliteTable(
  "repository_candidate_checks",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id").notNull().references(() => repositoryCandidates.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    name: text("name").notNull(),
    detail: text("detail"),
    state: text("state", { enum: ["passed", "waiting", "failed"] }).notNull(),
  },
  (table) => [uniqueIndex("idx_repository_candidate_checks_source").on(table.candidateId, table.sourceId)],
);

export const githubWebhookDeliveries = sqliteTable(
  "github_webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    event: text("event").notNull(),
    action: text("action"),
    installationId: text("installation_id"),
    repositoryId: text("repository_id"),
    receivedAt: integer("received_at").notNull(),
  },
  (table) => [index("idx_github_webhook_deliveries_received").on(table.receivedAt)],
);

export const repositoryPreflights = sqliteTable(
  "repository_preflights",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull().references(() => repositoryConnections.id),
    candidateId: text("candidate_id").notNull().references(() => repositoryCandidates.id),
    candidateSha: text("candidate_sha").notNull(),
    workflowInstanceId: text("workflow_instance_id"),
    status: text("status", { enum: ["provisioning", "running", "passed", "failed", "cancelled", "timed_out"] }).notNull(),
    summary: text("summary"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_repository_preflights_session_created").on(table.sessionId, table.createdAt),
    uniqueIndex("idx_repository_preflights_one_active").on(table.sessionId)
      .where(sql`${table.status} in ('provisioning', 'running')`),
    check("repository_preflights_status_check", sql`${table.status} in ('provisioning', 'running', 'passed', 'failed', 'cancelled', 'timed_out')`),
  ],
);

export const repositoryPreflightChecks = sqliteTable(
  "repository_preflight_checks",
  {
    id: text("id").primaryKey(),
    preflightId: text("preflight_id").notNull().references(() => repositoryPreflights.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    command: text("command").notNull(),
    status: text("status", { enum: ["pending", "running", "passed", "failed", "timed_out"] }).notNull(),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    outputExcerpt: text("output_excerpt"),
    logKey: text("log_key"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_repository_preflight_checks_position").on(table.preflightId, table.position),
    check("repository_preflight_checks_status_check", sql`${table.status} in ('pending', 'running', 'passed', 'failed', 'timed_out')`),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    queueItemId: text("queue_item_id").notNull().references(() => floorQueueItems.id),
    agentId: text("agent_id").notNull().references(() => floorAgents.id),
    candidateId: text("candidate_id").notNull().references(() => repositoryCandidates.id),
    candidateSha: text("candidate_sha").notNull(),
    runBranch: text("run_branch"),
    bundleKey: text("bundle_key"),
    bundleSizeBytes: integer("bundle_size_bytes"),
    localCommitSha: text("local_commit_sha"),
    runCommitSha: text("run_commit_sha"),
    remoteRunSha: text("remote_run_sha"),
    attempt: integer("attempt").notNull(),
    status: text("status", { enum: ["provisioning", "running", "checking", "ready", "publishing", "published", "integrating", "integrated", "conflicted", "failed", "cancel_requested", "cancelled"] }).notNull(),
    model: text("model").notNull(),
    workflowInstanceId: text("workflow_instance_id"),
    sandboxId: text("sandbox_id").notNull(),
    sandboxProcessId: text("sandbox_process_id"),
    // Legacy column name from the Codex-only era (same rule as
    // users.chatgpt_user_id): it now stores whichever provider's thread or
    // session id the run used. Never rename the SQL column — agent_runs has
    // four inbound ON DELETE CASCADE FKs and a set-null, and a drizzle
    // rename emits a table recreate that cascade-deletes children.
    providerThreadId: text("codex_thread_id"),
    summary: text("summary"),
    finalResponse: text("final_response"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    publishedAt: integer("published_at"),
    integrationBaseSha: text("integration_base_sha"),
    integratedCandidateSha: text("integrated_candidate_sha"),
    conflictReason: text("conflict_reason"),
    integrationStartedAt: integer("integration_started_at"),
    integratedAt: integer("integrated_at"),
    discardedAt: integer("discarded_at"),
    discardedBy: text("discarded_by").references(() => users.id),
    branchDeletedAt: integer("branch_deleted_at"),
    cancelRequestedAt: integer("cancel_requested_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_agent_runs_session_created").on(table.sessionId, table.createdAt),
    index("idx_agent_runs_agent_created").on(table.agentId, table.createdAt),
    uniqueIndex("idx_agent_runs_queue_attempt").on(table.queueItemId, table.attempt),
    uniqueIndex("idx_agent_runs_branch").on(table.candidateId, table.runBranch),
    uniqueIndex("idx_agent_runs_one_active_per_item").on(table.queueItemId)
      .where(sql`${table.status} in ('provisioning', 'running', 'checking', 'cancel_requested')`),
    check("agent_runs_status_check", sql`${table.status} in ('provisioning', 'running', 'checking', 'ready', 'publishing', 'published', 'integrating', 'integrated', 'conflicted', 'failed', 'cancel_requested', 'cancelled')`),
  ],
);

export const agentRunEvents = sqliteTable(
  "agent_run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    detail: text("detail").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_agent_run_events_sequence").on(table.runId, table.sequence)],
);

export const agentRunChecks = sqliteTable(
  "agent_run_checks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    command: text("command").notNull(),
    status: text("status", { enum: ["pending", "running", "passed", "failed", "timed_out"] }).notNull(),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    outputExcerpt: text("output_excerpt"),
    logKey: text("log_key"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_agent_run_checks_position").on(table.runId, table.position),
    check("agent_run_checks_status_check", sql`${table.status} in ('pending', 'running', 'passed', 'failed', 'timed_out')`),
  ],
);

export const agentRunFiles = sqliteTable(
  "agent_run_files",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    changeKind: text("change_kind", { enum: ["add", "update", "delete"] }).notNull(),
    additions: integer("additions").notNull(),
    deletions: integer("deletions").notNull(),
    summary: text("summary"),
    diffPreview: text("diff_preview").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_agent_run_files_path").on(table.runId, table.path)],
);

export const agentRunArtifacts = sqliteTable(
  "agent_run_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["codex_log", "diff", "prompt"] }).notNull(),
    r2Key: text("r2_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_agent_run_artifacts_kind").on(table.runId, table.kind)],
);

export const routingDecisions = sqliteTable(
  "routing_decisions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    queueItemId: text("queue_item_id").references(() => floorQueueItems.id, { onDelete: "set null" }),
    agentId: text("agent_id").references(() => floorAgents.id, { onDelete: "set null" }),
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    decision: text("decision", { enum: ["assigned", "dispatched", "held", "skipped"] }).notNull(),
    reason: text("reason").notNull(),
    candidates: text("candidates").notNull().default("[]"),
    triggeredBy: text("triggered_by", { enum: ["enqueue", "run_completed", "toggle", "agent_changed", "alarm"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_routing_decisions_session_created").on(table.sessionId, table.createdAt),
    index("idx_routing_decisions_item").on(table.queueItemId),
    check("routing_decisions_decision_check", sql`${table.decision} in ('assigned', 'dispatched', 'held', 'skipped')`),
    check("routing_decisions_trigger_check", sql`${table.triggeredBy} in ('enqueue', 'run_completed', 'toggle', 'agent_changed', 'alarm')`),
  ],
);

export const repositoryCheckCommands = sqliteTable(
  "repository_check_commands",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull().references(() => repositoryConnections.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    command: text("command").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_repository_check_commands_position").on(table.connectionId, table.position),
  ],
);

// Warm sandbox pool: run containers that outlive a single agent run so later
// runs against the same repository skip the container cold start and reuse the
// npm cache. Rows are claimed/released with guarded UPDATEs (same idempotency
// style as routing); the eviction sweep destroys idle or abandoned entries.
// Publisher sandboxes are never pooled — they handle GitHub credentials.
export const sandboxPool = sqliteTable(
  "sandbox_pool",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id").notNull(),
    state: text("state", { enum: ["idle", "claimed", "draining"] }).notNull(),
    claimedByRunId: text("claimed_by_run_id"),
    lastUsedAt: integer("last_used_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_sandbox_pool_repository_state").on(table.repositoryId, table.state, table.lastUsedAt),
  ],
);

// Session-scoped imported Claude skills: the owner pastes a SKILL.md, the
// run workflow materializes it into the container user's ~/.claude/skills/
// for Claude runs. `name` comes from validated frontmatter
// (lib/skill-validation.ts) and is filesystem-safe by construction — a
// lowercase slug, so no path separators or traversal segments can reach the
// materialization step. Content is bounded on the way in; per-session count
// is enforced at the write path.
export const sessionSkills = sqliteTable(
  "session_skills",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_session_skills_session_name").on(table.sessionId, table.name)],
);

// Per-user agent-provider credentials, encrypted at rest (AES-256-GCM via
// lib/credential-crypto.ts; key from the CREDENTIAL_ENCRYPTION_KEY Worker
// secret). `ciphertext` never leaves the server — routes return only the
// fingerprint (last four characters). `provider` and `kind` are open enums,
// TS-typed but deliberately without a SQL CHECK (same convention as
// agent_run_artifacts.kind) so adding a provider never requires a table
// recreate. The users FK cascade never fires in practice — deleteAccount
// scrubs the row instead of deleting it, so it deletes credentials explicitly.
export const userProviderCredentials = sqliteTable(
  "user_provider_credentials",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["anthropic", "openai"] }).notNull(),
    // ponytail: kind stays "api_key" until Anthropic approves third-party
    // OAuth for openfloor (claude.ai/Max/Pro login is disallowed for
    // third-party products). If that approval lands, a kind:"oauth" row slots
    // into this same identity and ciphertext column unchanged.
    kind: text("kind", { enum: ["api_key"] }).notNull().default("api_key"),
    ciphertext: text("ciphertext").notNull(),
    fingerprint: text("fingerprint").notNull(),
    validatedAt: integer("validated_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
);

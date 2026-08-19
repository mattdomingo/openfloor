import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    providerUserId: text("chatgpt_user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_users_chatgpt_user_id").on(table.providerUserId)],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  objective: text("objective"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  floorRevision: integer("floor_revision").notNull().default(0),
});

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
    status: text("status", { enum: ["queued"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_floor_queue_session_position").on(table.sessionId, table.position),
    index("idx_floor_queue_agent").on(table.agentId),
    check("floor_queue_status_check", sql`${table.status} in ('queued')`),
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
    branchName: text("branch_name").notNull(),
    baseBranch: text("base_branch").notNull(),
    baseSha: text("base_sha").notNull(),
    candidateSha: text("candidate_sha"),
    remoteBaseSha: text("remote_base_sha"),
    remoteCandidateSha: text("remote_candidate_sha"),
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
      .where(sql`${table.status} in ('creating', 'active')`),
    uniqueIndex("idx_repository_candidates_branch").on(table.connectionId, table.branchName),
    check("repository_candidates_status_check", sql`${table.status} in ('creating', 'active', 'creation_failed')`),
  ],
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

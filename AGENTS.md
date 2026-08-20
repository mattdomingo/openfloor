# OpenFloor Engineering Guide

This file is the authoritative repository-level guide for engineers and coding agents working on OpenFloor. It applies to the entire repository unless a more specific `AGENTS.md` is added in a subdirectory.

Last verified against `main`: 2026-08-19.

## Mandatory maintenance rule

**Every engineer and coding agent must update this file in the same change whenever the work introduces or changes a durable product, architecture, security, data-model, API, deployment, testing, or workflow decision.** Do not let important decisions live only in a chat, issue, pull request description, or code comment.

Examples that require an `AGENTS.md` update:

- Adding or removing a persisted entity, API route, event, binding, secret, or protected path.
- Changing what is authoritative versus ephemeral.
- Changing authentication, authorization, invite, membership, or concealment behavior.
- Changing the production mount path, deployment target, migration order, or local setup.
- Moving a deferred capability into the implemented product.
- Choosing a runtime, provider, repository model, queue lifecycle, ownership model, or review workflow.
- Establishing a new invariant that future contributors must preserve.

Small implementation details do not need a decision-log entry, but this document must stay factually correct. When uncertain, update it. Add new decisions to the decision log near the end of this file, including the date, decision, rationale, and consequences. If a decision supersedes an older one, preserve the history and mark the old entry as superseded rather than silently deleting it.

### Repository-execution milestone delivery protocol

The GitHub repository and agent-execution milestone is delivered one accepted phase at a time. Every phase must:

1. Contain only that phase's documented functionality; do not pre-implement later phases behind hidden UI or dormant production paths.
2. Pass the complete automated test pipeline before handoff.
3. Deploy to the active production environment when its browser acceptance flow depends on GitHub, Cloudflare runtime resources, or OpenAI, unless the user establishes a separate staging environment.
4. End with browser-based acceptance instructions that exercise the newly real end-to-end behavior.
5. Stop after handoff until the user explicitly accepts the phase.

The implementation plan currently has seven phases: GitHub connection; candidate workspace and reconciliation; sandbox preflight; local Codex candidate generation; run-branch publication; automatic integration and draft pull request; and final review, squash merge, and cleanup. Update this protocol and the decision log if that sequence is deliberately superseded.

## Read this first

Before changing code:

1. Read this file completely.
2. Read `README.md` for the concise setup and deployment path.
3. Read `docs/agent-backend-gaps.md` before touching agent runtime or review concepts.
4. Inspect the relevant route, database function, public type, client data source, and tests as one unit.
5. Check the worktree with `git status --short`. Preserve unrelated changes.
6. Decide whether the change affects an invariant or decision recorded here. If it does, plan the documentation update with the code change.

The repository intentionally contains a polished UI whose future-facing affordances are broader than the backend implemented today. Never infer that a visible control is backed by an execution system. Trace it to an API and D1 mutation before describing it as persistent or real.

## Product vision

### Ultimate goal

OpenFloor is a multiplayer coordination environment for teams of humans and software agents working on the same objective.

The long-term product should let a team enter one durable room, understand who and what is working, direct work to specialized agents, coordinate prompts and assignments, observe execution, communicate in context, inspect proposed changes, resolve conflicts, and approve work without losing the shared thread across people, tabs, devices, reconnects, or long-running tasks.

The metaphor is an **agent floor** rather than a collection of isolated chat windows:

- A session is the room.
- Human members are the team in that room.
- The objective is the room's shared mission.
- Agents are named collaborators owned by real session members.
- The queue is the team's shared backlog of prompts.
- Assignments clarify human ownership.
- Team chat and direct messages keep coordination in the room.
- Presence and live drafts make collaboration feel simultaneous.
- Review will eventually be the place where real repository changes, checks, conflicts, and candidate work are evaluated.

The product should eventually coordinate real coding-agent execution and repository work. It must not pretend that those integrations exist before they do.

### Why the project exists

Most agent tools are optimized for one person issuing one prompt to one agent. Real engineering work is collaborative: multiple people divide responsibilities, redirect work, ask each other questions, combine related prompts, watch progress, and review shared outcomes. OpenFloor is intended to make that multiplayer layer explicit and durable.

The immediate engineering strategy is to build the trustworthy collaboration substrate first:

1. Real identity.
2. Durable sessions and membership.
3. Secure reusable invitations.
4. Live presence.
5. Persistent collaborative floor state.
6. Clear empty states for capabilities that are not connected yet.
7. A future backend boundary for execution and repository data.

This order matters. A convincing simulation is not a substitute for an authoritative shared system.

## Product principles and non-negotiable invariants

### Real data or an honest empty state

Production code must not seed, fabricate, or animate agents, prompts, messages, assignments, file paths, branches, progress, checks, warnings, conflicts, diffs, reviews, terminal output, agent replies, or teammate behavior.

- New sessions start with real members and otherwise empty floor state.
- User-created collaboration data may be shown because it is persisted.
- Presence and teammate drafts may be shown because they come from authenticated live connections.
- Review remains `null` and renders “No review available” until an authoritative backend supplies review data.
- Test-only factories and fixtures may use sample values, but sample data must not be imported by production modules.
- Never add delayed canned responses, fake typing, artificial progress timers, deterministic routing disguised as intelligence, or mock terminal/worktree output.

### Authoritative state has one clear owner

OpenFloor has three intentionally separate state classes:

1. **D1-authoritative collaboration state**: users, sessions, memberships, invites, objective, agents, assignments, messages, queue items, queue prompts, ordering, and floor revision.
2. **Durable Object-coordinated ephemeral state**: online connections and teammate prompt drafts. This state is realtime but is not D1 history.
3. **Local UI state**: selected tabs, panel order and size, collapsed or expanded panels, queue filters, menus, dialogs, and the local visibility choice for teammate drafts.

Do not persist an ephemeral interaction merely because D1 is available. Do not leave collaborative state local merely because React state is convenient.

### Authorization is enforced on the server

- Every protected server page and every API mutation resolves an authenticated identity on the server.
- Every session-scoped read and write verifies membership in D1.
- Owner-only invite operations verify the `owner` role.
- The WebSocket upgrade is authenticated and membership-checked before the request reaches the Durable Object.
- Client-provided user IDs are never trusted as the acting identity.
- Targets such as agent owners, assignment owners, message recipients, agents, and queue items must belong to the same session.
- Non-members receive the same not-found response as nonexistent sessions. This concealment prevents metadata enumeration.

### Missing capabilities stay absent

Nullable and empty fields are a deliberate contract, not a temporary rendering bug. UI code must handle absence without inventing defaults. When a future backend is connected, it should provide authoritative data through typed interfaces and explicit mutations.

### Collaboration should survive reloads

Anything presented as durable collaboration must be stored in D1 and returned by the authoritative snapshot. A successful mutation returns the updated snapshot, increments `floor_revision` when it changes floor state, and notifies other clients to refetch.

### Realtime is a coordination signal, not a second database

WebSocket events notify clients about presence or changed domains. D1 remains authoritative for persisted floor data. Except for ephemeral typing drafts, do not turn the Durable Object into a shadow copy of floor records.

## Current product boundary

### Implemented and real

- Cloudflare Access authentication using Google or One-time PIN as configured by the production Access application.
- Server-only loopback development identity from `.dev.vars`.
- Internal user records keyed by the stable external provider subject.
- Session creation, listing, objective editing, membership, roles, and leaving.
- Owner-only session ending: `ended_at` marks the session read-only for everyone, revokes the active invite, and broadcasts `session.ended`; ended sessions stay readable and members can still leave.
- Owner-only session deletion (immediate and cascading for repository-free sessions) and a daily cron that purges repository-free sessions ended more than 30 days ago. Sessions with repository state fail closed until durable external cleanup exists. The home screen groups Active and Ended sessions.
- HMAC-signed, reusable owner invitations with rotation and revocation.
- Session lobby with real roster and live online status.
- Protected Agent Floor with real session title, objective, members, and presence.
- Persistent agent records created from required user input.
- Persistent member assignments.
- Persistent team messages and private direct messages.
- Persistent assigned or unassigned queue prompts.
- Manual queue ordering and same-target queue merging with prompt authorship preserved.
- Realtime floor revision notifications and snapshot refetching.
- Ephemeral realtime teammate prompt drafts with Everyone, Typing, and Hidden viewing modes.
- Movable, resizable, collapsible, expandable panels and responsive floor layout.
- Review navigation backed by genuine local agent-run files, diff previews, and checks when a run exists; otherwise it keeps an authoritative empty state.
- One GitHub repository connection per session, configured by the owner through a signed single-use GitHub App callback.
- Durable GitHub installation/repository identifiers, selected base branch, and ordered required-check commands.
- Member-visible repository details with owner-only connect, configure, disconnect, and reconnect controls.
- A public GitHub webhook boundary that caps payloads and verifies the raw-body HMAC before acknowledging them.
- One durable active repository candidate per session, created at a verified base SHA with owner-confirmed name/description on a server-generated `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>` branch.
- Owner-only repository synchronization with connected, ready, revoked, inaccessible, externally modified, and behind-base presentation.
- Idempotent GitHub installation, repository-access, rename, push, pull-request, check, and status delivery processing keyed by delivery ID.
- Owner-started repository preflight through a durable Cloudflare Workflow and an isolated Cloudflare Sandbox at the exact candidate SHA.
- Ordered required-check results in D1 with bounded command logs in private R2 and reload-safe provisioning, running, passed, failed, and timed-out UI states.
- Owner-started and owner-cancelled queue execution through a durable `AgentRunWorkflow`, with one active run per queue item.
- Server-side Codex SDK execution using `gpt-5.6-terra` in an isolated Sandbox at the exact candidate SHA, with workspace-write permission and no repository network access.
- Durable run, event, check, changed-file, and artifact metadata; bounded complete logs and diffs live in private R2.
- Real run status and file/check data in Agent cards and Review. Each passing run is automatically preserved on its own verified `openfloor/<session-short>/run/<run-short>` GitHub branch; consecutive prompts retain separate branches and audit history.
- Trusted incremental Git-bundle validation and non-force publication from a clean publisher Sandbox, followed by GitHub SHA reconciliation.
- Owner-only safe discard using an expected-SHA lease; externally modified run branches are never deleted.
- Serialized candidate integration inside `AgentRunWorkflow`, with a D1 candidate lease, authoritative GitHub ref reconciliation, non-force merge, one draft PR, queue completion, conflict preservation, and owner-only retry as a new run attempt.
- GitHub-authoritative final review snapshots with bounded PR files, check runs, commit statuses, head/base SHAs, draft state, mergeability, and merge-requirement state.
- Owner-only **Ready for review** and expected-head **Squash merge** actions. GitHub protection and review requirements are never bypassed.
- Verified post-merge cleanup of matching server-generated run/candidate refs using Git leases; mismatched refs are preserved and recorded as partial cleanup.
- Merged candidate audit history remains durable, while the next owner-started run creates a fresh candidate cycle from the latest base SHA.

Known production follow-up: the owner discard action still reports failure in the disposable acceptance repository after its Git authentication correction. Preserve the expected-SHA lease and error separation; diagnose this independently rather than weakening deletion safety or folding it into Phase 6.

### Explicitly deferred

- Agent model/provider selection and user-managed provider credentials; Phase 4 deliberately uses one server-configured Codex model and project credential.
- Agent-authored chat messages and generic artifact download UI beyond the per-run raw-log expander. (Live run activity streaming is now real: the sandbox runner posts normalized Codex events to `/runtime/run/events`, they persist in `agent_run_events`, and sessions receive them as `run.activity` presence events.)
- Deployment automation after repository merge.
- Agent edit, archive, deletion, or lifecycle states beyond `created`.
- Queue completion, removal, consumption, or retry workflows.
- Ownership transfer. Owners cannot leave until transfer exists.
- Persistent draft history. Live prompt drafts are intentionally ephemeral.

See `docs/agent-backend-gaps.md` for the focused backend-gap summary. When any deferred capability becomes real, update both that document and this file.

## User experience and route map

Production is mounted under `/app` on `opnflr.com`. Local `npm run dev` is mounted at the root.

| Production route | Local dev route | Access | Purpose |
| --- | --- | --- | --- |
| `/app` | `/` | Public | Product landing and entry into Cloudflare Access. |
| `/app/home` | `/home` | Protected | Sessions where the current user is a member; session creation. |
| `/app/onboarding` | `/onboarding` | Protected | First-login account setup (profile picture, name, GitHub handle); gates `/home`, `/join/*`, and `/session/*` until complete. |
| `/app/join/[token]` | `/join/[token]` | Protected | Valid invite preview followed by explicit acceptance. |
| `/app/session/[id]` | `/session/[id]` | Protected/member-only | Session lobby, roster, invite controls, leave, and floor entry. |
| `/app/session/[id]/floor` | `/session/[id]/floor` | Protected/member-only | Main collaborative Agent Floor. |
| `/app/api/...` | `/api/...` | Protected | Authenticated application interfaces. |
| `/app/api/sessions/[id]/presence` | `/api/sessions/[id]/presence` | Protected/member-only | WebSocket upgrade. |
| `/app/webhooks/github` | `/webhooks/github` | Public/signed | GitHub delivery boundary; verifies payload size and HMAC before acknowledging. |

Important behavior:

- The landing page owns no password, OAuth callback, or application login session.
- Clicking Sign in navigates to a protected path; Cloudflare Access performs the login and returns the browser.
- `/cdn-cgi/access/logout` is the production sign-out endpoint.
- A join page reveals session title and owner only after authentication and only for a valid, active signed token.
- Opening a join URL does not change membership. The user must click Join.
- Invite acceptance is idempotent because the session membership key is unique.
- Non-members opening a session or floor get a 404-style not-found response rather than session details.
- A member who leaves is disconnected from the room's presence object.
- An owner receives a conflict response if they try to leave.
- An owner can end the session instead. Ending is final in v1 (no un-end), idempotent, revokes the active invite in the same batch, and leaves all data readable. Collaboration, repository, preflight, run, and review mutations on an ended session return `409` with "This session has ended." — never `404`, which clients treat as "kicked from the session". Run cancellation remains available so already-running work can be stopped. Presence sockets stay open on ended sessions by design.
- Repository details are visible to session members, but only the owner can connect, configure, disconnect, or reconnect.
- The GitHub installation callback is protected by Access, signed, expires after 30 minutes, is bound to the initiating owner and session, and can be consumed once.
- The webhook path must remain outside Cloudflare Access so GitHub can deliver events; signature verification is its authentication boundary.

## System architecture

The request and synchronization flow is:

```text
Browser
  -> Cloudflare Access policy for protected production paths
  -> OpenFloor Worker
       -> verifies Access JWT or explicit loopback development identity
       -> strips any client-supplied trusted identity headers
       -> forwards verified identity to the vinext/Next application
  -> Server Component or API route
       -> upserts internal user
       -> validates input
       -> checks membership/role in D1
       -> reads or mutates D1 with prepared statements
       -> notifies the per-session Durable Object when needed
  -> Browser receives authoritative response

Per-session WebSocket
  -> Worker authenticates and verifies D1 membership
  -> Worker forwards trusted internal user ID and display name
  -> SessionPresence Durable Object
       -> hibernating sockets and serialized attachments
       -> online-user deduplication across tabs
       -> ephemeral typing-draft aggregation across tabs
       -> presence/session/member/floor notifications
  -> Clients update presence directly or refetch D1 FloorSnapshot
```

### Runtime and framework

- Next.js App Router and React Server Components.
- vinext and Vite compile the application for Cloudflare Workers.
- `worker/index.ts` is the production Worker entry point.
- Cloudflare D1 is the relational database bound as `DB`.
- `SessionPresence` is a SQLite-backed Durable Object bound as `SESSION_PRESENCE`.
- `RepositoryPreflightWorkflow` is bound as `REPOSITORY_PREFLIGHT`; it durably coordinates exact-source checkout, ordered checks, result persistence, and cleanup.
- `AgentRunWorkflow` is bound as `AGENT_RUN_WORKFLOW`; it durably coordinates exact-source checkout, Codex, required checks, Git-bundle export, trusted publication, reconciliation, cancellation, and cleanup.
- `Sandbox` is the `@cloudflare/sandbox` Durable Object bound as `SANDBOX`, backed by the matching `cloudflare/sandbox:0.12.7` container image.
- Private bounded preflight and run artifacts are stored in R2 bucket `openfloor-preflight-logs`, bound as `PREFLIGHT_LOGS`.
- Cloudflare static assets are bound as `ASSETS`.
- Cloudflare Images is bound as `IMAGES` for vinext image optimization.
- Drizzle defines the schema and generates migrations; runtime data access uses prepared D1 SQL.
- TypeScript is strict enough that public contract changes should fail typecheck and tests.

### Important hosting topology

- The marketing site owns the apex `opnflr.com` deployment.
- The OpenFloor application is peeled off under `/app` by a more-specific Worker route.
- `next.config.ts` sets `basePath` to `/app` only for production. Enabling it in development breaks stylesheet resolution because the source `app/` directory and URL prefix collide.
- `components/basePath.ts` exists for literal public/API/WebSocket paths that the framework does not rewrite automatically.
- Use Next `Link` with unprefixed application paths such as `/home` and `/session/...`; Next applies the production base path.
- Use `BASE_PATH` for manual `fetch`, `WebSocket`, and `public/` URLs.
- `wrangler.jsonc` claims `opnflr.com/app*` because Cloudflare route matching cannot express the desired query-string behavior with a bare exact route. This prefix is broader than ideal; the marketing-site test guards collisions such as `/approach`.
- The font route `opnflr.com/assets/_vinext_fonts/*` is also claimed because generated font URLs are not under the application base path.
- Asset `not_found_handling` must remain `none` so `/app`-prefixed asset requests can fall through to the Worker, be stripped, and be resolved through `ASSETS`.
- `.openai/hosting.json` and `build/sites-vite-plugin.ts` package Sites metadata and migrations during builds, but the current production runbook deploys the built Worker directly with Wrangler because Durable Object presence is a required capability. Do not switch the deployment path without proving D1, Durable Object, Access, asset, and route behavior end to end.

## Authentication and identity

### Current decision: Cloudflare Access

Production identity is Cloudflare Access, not application-owned “Sign in with ChatGPT.” Google and One-time PIN are the intended Access identity providers. The Access application protects:

- `opnflr.com/app/home`
- `opnflr.com/app/onboarding`
- `opnflr.com/app/session/*`
- `opnflr.com/app/join/*`
- `opnflr.com/app/api/*`

The public `/app` landing and required assets remain outside Access.

The Worker validates the `cf-access-jwt-assertion` using:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`
- the team's JWKS at `/cdn-cgi/access/certs`
- issuer, audience, signature, and token expiry through `jose`

The provider user ID is stored as `cloudflare-access:<sub>`. Email and name are mutable display metadata, not identity keys.

### Legacy schema naming

The `users.chatgpt_user_id` column and `idx_users_chatgpt_user_id` index retain names from the earlier ChatGPT-identity design. In current code this column stores the generic stable `providerUserId`, currently the prefixed Cloudflare Access subject.

Do not build logic that assumes the column contains a ChatGPT ID. Do not rename it casually: a rename requires a generated D1 migration, updated queries, integration tests, and a deployment plan.

### Trusted-header boundary

`worker/index.ts` verifies external identity and calls `requestWithTrustedIdentity`. That helper always deletes any client-provided internal trusted headers before adding verified values. Application code reads only those internal headers through `app/access-auth.ts`.

The WebSocket path does not rely on the application handoff. `handlePresenceRequest` authenticates at the Worker, resolves the internal user through D1 membership, and sends only trusted internal identity headers to the Durable Object.

### Local development and tests

- Local identity works only for loopback hosts (`localhost` or `127.0.0.1`) using `OPENFLOOR_DEV_USER_ID`, `OPENFLOOR_DEV_USER_EMAIL`, and `OPENFLOOR_DEV_USER_NAME`.
- Protected production requests must reject requests without a valid Access identity; the `/app` landing page remains public by design.
- Test-controlled identity headers work only when `OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS=true`, which test configuration provides explicitly.
- Never broaden the development fallback to arbitrary hosts.
- Never enable test identity headers in production.

## Persistence model

### Schema workflow

`db/schema.ts` is the schema source. Drizzle writes migrations to `drizzle/`. Runtime queries live in `db/sessions.ts` and `db/floor.ts` and use prepared D1 statements.

When changing persisted schema:

1. Edit `db/schema.ts`.
2. Run `npm run db:generate`.
3. Inspect the generated SQL and metadata. Never accept a destructive migration blindly.
4. Add or update D1 integration tests.
5. Apply locally with `npx wrangler d1 migrations apply openfloor-production --local`.
6. Run the complete test pipeline.
7. Apply remotely before deploying code that depends on the migration.

Do not hand-edit Drizzle metadata. If a generated migration is wrong, correct the schema or migration deliberately and verify both a new database and the intended production transition.

### Tables and invariants

#### `users`

- Internal UUID primary key.
- Unique stable provider identity in legacy-named `chatgpt_user_id`.
- Email and display name update on authentication.
- Creation and update timestamps are epoch milliseconds.

#### `sessions`

- UUID, title, nullable objective, timestamps.
- `floor_revision` is a monotonically increasing integer for persisted floor reconciliation.
- Session creation also creates owner membership and an active invite in one D1 batch.
- Nullable `ended_at` is the lifecycle marker. Null means live; a timestamp means ended and read-only. Writes authorize through `getActiveMembershipRole` (throws `SessionEndedError` for members of ended sessions); reads keep using `getMembershipRole` so ended sessions stay viewable. `leaveSession`, `endSession`, `deleteSession`, and non-member concealment intentionally bypass the ended guard.
- Retention: the Worker's `scheduled()` handler (daily cron in `wrangler.jsonc`) runs `purgeExpiredSessions`, deleting repository-free sessions with `ended_at` older than `ENDED_SESSION_RETENTION_MS` (30 days), then broadcasts `members.changed` so connected tabs refetch. Never-ended sessions and sessions with any repository connection are never purged automatically. Manual deletion uses the same repository-state guard.

#### `session_members`

- Composite primary key `(session_id, user_id)`.
- Role is `owner` or `member`.
- Owner is created with the session.
- There is currently no ownership-transfer route.

#### `session_invites`

- UUID identifies the invite record.
- Only one active non-revoked invite may exist per session, enforced by a partial unique index.
- The bearer token is `invite-id.signature`, where the signature is HMAC-SHA256 using `INVITE_SIGNING_SECRET`.
- D1 stores no bearer secret.
- GET reconstructs the active signed URL; POST revokes the old invite and creates a new one; DELETE revokes the active invite.
- Invalid, forged, missing, or revoked tokens reveal no session information.

#### `github_connection_states`

- A state record binds a GitHub App installation attempt to one session owner.
- The browser receives only `state-id.HMAC-SHA256-signature`; the signing secret stays in Worker bindings.
- A state expires after 30 minutes and its callback can be consumed only once.
- A consumed state remains pending until repository configuration succeeds, then receives `configured_at`.

#### `repository_connections`

- There is at most one row per session.
- Numeric GitHub installation and repository IDs are stored as strings and remain authoritative across repository renames; owner/name/full-name are display metadata.
- Status is `connected`, `ready`, `revoked`, `inaccessible`, `externally_modified`, or `disconnected`; GitHub is authoritative and synchronization never repairs a changed ref automatically.
- Disconnect changes status to `disconnected` and preserves connection, candidate, and check history.

#### `repository_candidates`

- Durable rows record the owner-confirmed candidate name and description, exact base SHA, generated candidate ref, expected candidate SHA, last observed remote SHAs, and synchronization time.
- A partial unique index permits only one `creating` or `active` candidate per session.
- Candidate refs are generated only by the server as `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>` and are created without force from the configured base ref. The owner supplies bounded display metadata, not an arbitrary ref; OpenFloor normalizes the name into a lowercase ASCII slug and retains the unique ID suffix.
- A newer base SHA marks the candidate behind; an unexpected candidate head marks the connection externally modified. Neither condition rewrites GitHub.
- Status is `creating`, `active`, `merged`, or `creation_failed`. Only creating/active rows participate in the one-live-candidate constraint, so merged history does not block the next cycle.
- The row stores the active PR identity/state plus GitHub mergeability, merge-requirement state, aggregate observed-check result, ready/merge audit timestamps, confirmed squash SHA, and cleanup outcome. The first draft PR uses the persisted candidate name as its title and description as its body.

#### `repository_candidate_files` and `repository_candidate_checks`

- These tables store a bounded, last-reconciled GitHub PR review snapshot. Files contain path, change kind, counts, and bounded patch preview; checks normalize GitHub check runs and commit statuses to passed/waiting/failed.
- GitHub remains authoritative. Ready and merge mutations refresh these tables before deciding, and webhook events invalidate the review revision so clients refetch.
- Complete logs, bundles, and unbounded diffs remain outside D1.

#### `github_webhook_deliveries`

- The GitHub delivery ID is the primary key, so a replay is acknowledged without applying its state transition twice.
- Installation, repository-access, repository rename/delete, push, pull-request, check-run/check-suite, and status events update or invalidate repository/review state only after raw-body HMAC verification.

#### `repository_check_commands`

- Stores zero to eight owner-configured shell commands in explicit zero-based order.
- Commands are inert until the owner explicitly starts a preflight or later agent run. Preflight snapshots the ordered list before execution.
- An empty list is valid for repository connection, but Verify runner and every later execution/integration action fail closed until at least one command is configured.

#### `repository_preflights` and `repository_preflight_checks`

- One `provisioning` or `running` preflight may exist per session; terminal history is retained.
- A preflight pins the active candidate ID and SHA and snapshots each required command in order.
- D1 owns bounded status, timing, exit code, excerpt, and R2 log-key metadata. Full bounded logs stay in private R2 and never enter snapshots.
- Statuses are `provisioning`, `running`, `passed`, `failed`, `cancelled`, or `timed_out`; check statuses are `pending`, `running`, `passed`, `failed`, or `timed_out`.

#### `agent_runs`, `agent_run_events`, `agent_run_checks`, `agent_run_files`, and `agent_run_artifacts`

- One active run may exist per queue item. Runs pin the agent, candidate, exact SHA, attempt, model, prompt inputs, timestamps, and terminal summary.
- The owner may start or cancel; members may read caller-visible run summaries but receive no mutation controls. Unassigned or nonqueued items cannot execute.
- Run statuses are `provisioning`, `running`, `checking`, `ready`, `publishing`, `published`, `integrating`, `integrated`, `conflicted`, `failed`, `cancel_requested`, and `cancelled`; every listed status is now used by the Phase 6 lifecycle.
- Each run snapshots ordered required checks. D1 stores bounded output excerpts, file metadata, and diff previews; complete bounded Codex logs, check logs, and diffs stay in private R2.
- `ready` means checks passed locally. The Workflow immediately moves through `publishing`, `published`, and serialized `integrating`; success records `integrated` and completes the queue item, while a true GitHub merge conflict records `conflicted` and leaves the item blocked for owner retry.
- Each new run stores a server-generated run branch, bundle key/size, local bundle commit, trusted published commit, observed remote SHA, publication time, and nullable discard audit fields. Older Phase 4 runs may have null publication fields.
- The agent Sandbox uploads a bounded incremental bundle through an operation-scoped JWT. A separate clean publisher Sandbox reconstructs the deterministic archive baseline from the exact candidate tree, verifies one ref and one result commit, compares the recorded file set, enforces object/file limits, and performs a fixed non-force push with a repository-limited token. Git-over-HTTPS authenticates with `x-access-token` plus the installation token as the HTTP Basic password; REST-style Bearer authentication is not valid for this Git transport. Restarting a Workflow whose run is already `publishing` resumes from the stored bundle and file metadata without rerunning Codex or checks.
- Discard reads the current remote ref and deletes with `--force-with-lease=<expected-sha>` only when the server-generated branch and recorded/reconciled SHAs still match. D1/R2 audit history remains.
- The active candidate holds at most one `integration_run_id`. Each integrating Workflow reconciles base, candidate, and run refs from GitHub, merges the immutable run commit into the latest candidate without force, updates the expected/remote candidate SHA, and creates a draft PR only when the candidate has none. Retry against a conflict creates a new attempt and run branch from the latest candidate; it never rewrites the conflicted branch.
- Workflow-file changes under `.github/workflows/` are rejected because the GitHub App has no Workflows permission.
- `branch_deleted_at` records verified post-merge cleanup separately from owner-requested discard; both retain the run and its audit metadata.

#### `floor_agents`

- Session-scoped UUID.
- Creator and owner are real users; owner must be a member of the same session.
- Name, free-text role, and task are required user input.
- `name_key` is NFKC-normalized, whitespace-collapsed, and lowercased for case-insensitive uniqueness per session.
- The only valid lifecycle state is currently `created`.
- No runtime fields, model, branch, progress, files, or checks exist.

#### `floor_assignments`

- Composite key `(session_id, user_id)`.
- Nullable task means no assignment.
- Records the last editor and timestamp.
- The target user must still be a member of the same session.

#### `floor_messages`

- Team message when `recipient_user_id` is null.
- Direct message when a recipient exists.
- Snapshot reads return all team messages plus only DMs authored by or addressed to the current user.
- Because of DM filtering, two members can receive different `FloorSnapshot.messages` arrays at the same floor revision. Never cache one user's floor snapshot as a room-global payload.

#### `floor_queue_items`

- Ordered by integer `position` within a session.
- Nullable agent target represents an unassigned prompt.
- Status is `queued`, `running`, `blocked`, or `completed`. Only queued items can be merged or started.
- Agent foreign key uses `ON DELETE SET NULL` for future lifecycle support, although deletion is not exposed today.

#### `floor_queue_prompts`

- A queue item contains one or more authored prompts.
- Merging moves prompts into the surviving same-target item, preserving every prompt, author, and creation time.
- Ordering mutations submit the exact set of current item IDs. A stale or incomplete order returns a conflict instead of silently dropping records.

### Snapshot contract

`FloorSnapshot` in `lib/floor-types.ts` is the public authoritative floor response:

- `revision`
- `agents`
- `assignments`
- `messages`
- `queue`
- `repository`
- `activeCandidate`
- `latestPreflight`
- `runs`
- `review`

`FloorSnapshot` includes nullable `repository`, `activeCandidate`, bounded `latestPreflight`, and the latest 20 caller-visible runs. Large logs and artifacts are fetched separately. `review` is null until a real run has changed files, then is derived only from persisted run/check/file data; never populate it from UI fixtures.

### Mutation pattern

Persisted floor mutations follow this sequence:

1. Authenticate the acting user.
2. Parse and normalize bounded input.
3. Verify session membership.
4. Verify every referenced target belongs to the same session.
5. Write data and increment `sessions.floor_revision` in a D1 batch.
6. Read and return the acting user's authoritative `FloorSnapshot`.
7. Broadcast `floor.changed { revision, domains }` through `SessionPresence`.
8. Other clients with an older revision refetch `/floor`.

Preserve this pattern unless a documented architecture decision replaces it.

## Realtime model

### Durable Object ownership

There is one `SessionPresence` Durable Object instance per session ID, obtained with `idFromName(sessionId)`. It uses Cloudflare's hibernating WebSocket API and serialized socket attachments. Do not add process-local registries or polling as a substitute.

### Presence

- A user becomes online on their first open socket.
- Multiple tabs are deduplicated by internal user ID.
- A user becomes offline after their last socket closes.
- Initial connection receives `presence.snapshot` with online IDs and current nonempty typing drafts.
- Other clients receive `presence.changed` only when the user's aggregate online state changes.
- Clients reconnect with bounded exponential backoff and do not deliberately mark everyone offline during a transient reconnect.

### Persisted-change events

`PresenceEvent` currently includes:

- `presence.snapshot`
- `presence.changed`
- `typing.changed`
- `members.changed`
- `session.changed`
- `session.ended`
- `floor.changed`
- `run.activity`
- `error`

Event behavior:

- `members.changed` causes roster and floor refresh.
- `session.changed` carries the objective and timestamp; clients use last-write-wins by timestamp.
- `session.ended` carries `endedAt`; clients switch to the read-only presentation without closing their sockets.
- `floor.changed` carries revision and changed domains; clients refetch if the event revision is newer.
- `run.activity` carries `{ runId, agentId, events }` batches of persisted run activity; it never bumps `floor_revision`, and clients merge by sequence, catching up through `GET /api/sessions/:id/runs/:runId/events?after=<sequence>`.
- Membership removal explicitly closes that user's sockets with a membership-ended code.

### Live teammate drafts

Live prompt drafts are intentionally ephemeral and are never written to D1.

- The client sends `typing.update { text, typing }` on the authenticated room socket.
- Draft text is bounded to 4,000 characters.
- Socket attachments store that tab's draft, typing flag, and monotonic update timestamp.
- The Durable Object aggregates tabs by user. Closing one tab does not clear a draft still active in another.
- The latest active tab wins; otherwise the latest nonempty idle draft is retained while the connection exists.
- Submitting, leaving the floor, or disconnecting clears that connection's draft.
- The composer marks the user idle after 1.8 seconds without input. This is a real typing-presence timeout, not a mock animation.

The local viewing modes are:

- **Typing**: default; show only teammates actively typing.
- **Everyone**: show every teammate's lane, including the last nonempty idle draft for a connected teammate.
- **Hidden**: show no teammate draft lanes.

Hidden is a local visibility preference. It does **not** disable sharing the current user's own draft. A privacy control that stops broadcasting would be a separate product and protocol decision and must be named clearly if introduced.

## API contracts

All paths below are shown without the production `/app` prefix.

| Method and path | Authorization | Behavior |
| --- | --- | --- |
| `POST /api/sessions` | Authenticated user | Create `{ title, objective? }`; creator becomes owner; returns session and active invite URL. |
| `PATCH /api/sessions/[id]` | Session member | Update `{ objective: string \| null }`; broadcasts `session.changed`. |
| `GET /api/sessions/[id]/members` | Session member | Return authorized roster. |
| `GET /api/sessions/[id]/invite` | Owner | Return active reusable signed link or null. |
| `POST /api/sessions/[id]/invite` | Owner | Rotate/create link; old link becomes invalid. |
| `DELETE /api/sessions/[id]/invite` | Owner | Revoke active link. |
| `POST /api/invites/[token]/accept` | Authenticated user | Idempotently add member and broadcast `members.changed`. |
| `DELETE /api/sessions/[id]/membership` | Non-owner member | Leave, disconnect presence, and notify roster. |
| `POST /api/sessions/[id]/end` | Owner | Idempotently set `ended_at`, revoke the active invite, and broadcast `session.ended`. |
| `DELETE /api/sessions/[id]` | Owner | Hard-delete a repository-free session; children cascade. Returns `409` when repository state must be preserved. Broadcasts `members.changed` after deletion so open tabs refetch, hit the 404 concealment, and return to `/home`. |
| `GET /api/sessions/[id]/floor` | Session member | Return the caller-specific authoritative `FloorSnapshot`. |
| `POST /api/sessions/[id]/agents` | Session member | Create `{ name, role, task, ownerUserId }`. |
| `PATCH /api/sessions/[id]/assignments/[memberId]` | Session member | Persist `{ task: string \| null }`. |
| `POST /api/sessions/[id]/messages` | Session member | Persist `{ text, recipientUserId? }`. |
| `POST /api/sessions/[id]/queue` | Session member | Persist `{ prompt, agentId? }`; null target is valid. |
| `PATCH /api/sessions/[id]/queue/order` | Session member | Persist an exact unique `{ itemIds }` order. |
| `POST /api/sessions/[id]/queue/merge` | Session member | Merge at least two existing same-target items, preserving prompts. |
| `GET /api/sessions/[id]/presence` with Upgrade | Session member | Authenticated WebSocket handoff to the per-session Durable Object. |
| `POST /api/sessions/[id]/repository/connect` | Owner | Create a short-lived signed GitHub installation state and return the installation URL. |
| `GET /api/github/callback` | Authenticated initiating owner | Consume the signed installation callback once and return to repository setup. |
| `GET /api/sessions/[id]/repository` | Session member | Return the durable repository connection and ordered required checks, or null. |
| `GET /api/sessions/[id]/repository/options` | Owner | List repositories and branches available to the pending or connected installation. |
| `POST /api/sessions/[id]/repository` | Owner with pending callback | Persist the selected repository, base branch, and required commands. |
| `PATCH /api/sessions/[id]/repository` | Owner | Change the base branch or required commands for the same connected repository. |
| `DELETE /api/sessions/[id]/repository` | Owner | Mark the connection disconnected without mutating GitHub. |
| `POST /api/sessions/[id]/repository/candidate` | Owner | Accept bounded `{ name, description }` metadata (defaulted by the UI and legacy empty-body callers from the session title/objective), verify the configured base SHA, and create one safely slugged server-owned candidate branch without force. |
| `POST /api/sessions/[id]/repository/sync` | Owner | Reconcile repository metadata and base/candidate heads without modifying GitHub. |
| `GET /api/sessions/[id]/repository/preflight` | Session member | Return the latest bounded preflight/check state. |
| `POST /api/sessions/[id]/repository/preflight` | Owner | Start one durable preflight for the exact active candidate; requires at least one command. |
| `GET /api/sessions/[id]/repository/preflight/[preflightId]/logs` | Session member | Stream the caller-authorized bounded command logs from private R2. |
| `GET /runtime/preflight/source` | Short-lived source JWT | Proxy the exact candidate archive without exposing a GitHub installation token to the Sandbox process. |
| `POST /api/sessions/[id]/queue/[queueItemId]/run` | Owner | Start a durable Codex run for an assigned queued item at the exact active candidate SHA. |
| `POST /api/sessions/[id]/runs/[runId]/cancel` | Owner | Request cancellation of an active run. |
| `POST /api/sessions/[id]/runs/[runId]/discard` | Owner | Delete only an unchanged, verified OpenFloor run branch using an expected-SHA lease; retain audit history. |
| `POST /api/sessions/[id]/runs/[runId]/retry` | Owner | Retry a conflicted queue item as a new run attempt pinned to the latest candidate SHA. |
| `POST /api/sessions/[id]/review/ready` | Owner | Reconcile the exact active PR and use GitHub's ready-for-review mutation; preserve 404 concealment. |
| `POST /api/sessions/[id]/review/merge` | Owner | Reconcile head/base/files/checks/mergeability, request an exact-head squash merge, confirm it, and safely clean matching OpenFloor refs. |
| `GET /api/sessions/[id]/runs/[runId]/artifacts` | Session member | Return caller-authorized bounded run artifacts from private R2. |
| `GET /api/sessions/[id]/runs/[runId]/events` | Session member | Return one run's persisted activity timeline incrementally via `?after=<sequence>`. |
| `POST /runtime/run/events` | Short-lived run events JWT | Ingest bounded, runner-sequenced activity events for one active run and broadcast them as `run.activity`. |
| `GET /runtime/run/source` | Short-lived run source JWT | Proxy the exact candidate archive for one run. |
| `POST/GET /runtime/run/bundle` | Short-lived operation JWT | Store an agent-exported bounded Git bundle and serve it only to the clean trusted publisher. |
| `POST /runtime/openai/v1/responses` | Short-lived run OpenAI JWT | Forward one active run's Codex request while injecting the project credential outside the repository process. |
| `POST /webhooks/github` | Valid GitHub HMAC | Deduplicate and process bounded installation, access, repository, push, PR, check, and status deliveries. |

Response conventions:

- `401` means no authenticated identity.
- `400` means invalid input or a cross-session/invalid target.
- `404` conceals nonexistent sessions, non-membership, unauthorized owner-only resources, invalid invites, and revoked invites.
- `409` represents conflicts such as duplicate normalized agent name, stale queue order, owner leave, or any mutation on an ended session ("This session has ended.").
- Floor mutations return `{ floor }`; clients treat it as authoritative.

### Validation limits

Keep server validation in `lib/validation.ts` and cover it with unit tests.

- Session title: required, trimmed, maximum 100 characters.
- Objective: nullable, trimmed, empty becomes null, maximum 2,000.
- Agent name: required, NFKC-normalized, whitespace-collapsed, maximum 24.
- Agent role: required, trimmed, maximum 80.
- Agent task: required, trimmed, maximum 1,000.
- Assignment: nullable, trimmed, empty becomes null, maximum 2,000.
- Message: required, trimmed, maximum 4,000.
- Queue prompt: required, trimmed, maximum 4,000.
- Queue order/merge ID list: unique strings, maximum 500 items; merge requires at least two.
- Live draft: maximum 4,000, not trimmed because it represents in-progress text.
- Repository selection: repository ID maximum 100 characters; base branch required and maximum 255 characters.
- Required check commands: optional; zero to eight ordered nonempty commands, trimmed, maximum 500 characters each.
- Candidate name: required, NFKC-normalized, whitespace-collapsed, maximum 100 characters; it is slugged server-side and never accepted as a complete ref. Candidate description: trimmed, maximum 2,000 characters and may be empty.

## Frontend architecture

### Server/client boundary

- Protected pages authenticate, upsert the user, authorize membership, and server-load initial data.
- Product screens under `components/product/` own page-level client behavior such as WebSocket connection, invite state, and routing.
- The Agent Floor receives the first `FloorSnapshot` from the server to avoid a loading-only shell.
- `usePersistentFloorData` is the asynchronous data-source boundary for floor reads and writes.
- A mutation response updates local state immediately; a newer remote floor revision triggers a refetch.

### Agent Floor structure

- `Workspace.tsx`: orchestration and local layout state.
- `TopBar.tsx`: workspace/review navigation, real member presence, owner invite dialog, settings, sign-out.
- `ObjectiveBar.tsx`: persistent member-editable objective.
- `BriefRail.tsx`: real members, assignments, team chat, and DMs.
- `AgentFloor.tsx` and `AgentCard.tsx`: empty state, creation dialog, and persisted agent metadata only.
- `PromptQueue.tsx`: real queue filtering, ordering, merging, targeting, and prompts.
- `FloorDock.tsx`: queue composer, target selection, live teammate drafts, and draft visibility controls.
- `ReviewScreen.tsx`: consumes nullable review types and renders an honest empty state today.
- `Rail.tsx`: panel chrome, movement, collapse, expansion, and resize behaviors.

### UI state that is intentionally local

The following currently reset on reload and must not be mistaken for shared data:

- Workspace versus Review selection.
- Selected agent and focus/all layout.
- Panel order, widths, collapse, and expansion.
- Queue scope, ordering mode, merge mode, and drag state.
- Selected chat thread and Team panel view.
- Teammate draft visibility mode.
- Menus, dialogs, transient notices, and form input before submission.

If product requirements call for any of these to persist or synchronize, add an explicit storage owner and document the decision.

The theme choice is deliberately a per-device preference: localStorage `openfloor:theme`, owned by `components/ThemeToggle.tsx`, never synchronized through D1 or presence.

### Styling

- Global styles are composed from `app/globals.css` and files under `app/styles/`.
- `tokens.css` is the design-token source.
- Theming: the bare `:root` block in `tokens.css` is the light theme; the dark values live twice (under `prefers-color-scheme` guarded by `:root:not([data-theme="light"])`, and under `:root[data-theme="dark"]`) and must stay identical. `components/ThemeToggle.tsx` cycles System → Light → Dark, persisting the manual choice in localStorage (`openfloor:theme`); an inline script in `app/layout.tsx` applies it pre-paint. Never hardcode a color a theme must change — the code workbench's inverse surfaces are the deliberate exception (dark in both themes).
- `components/session/SelectMenu.tsx` is the house dropdown (trigger + styled listbox, combobox keyboard semantics). Do not introduce native `<select>` elements; the OS widget does not match the floor.
- The `legacy-floor-*` filenames describe their origin in the preserved demo UI, not permission to restore demo behavior.
- Reuse genuine visual primitives, but do not reintroduce fixture imports, fake terminals, or simulation logic with old CSS.
- The responsive floor stacks panels and draft lanes on smaller screens.

### Preserved prototype

The complete pre-persistence demo is recoverable from branch `codex/demo-ui-snapshot` at commit `5958f34`. Use it only as a visual interaction reference. Never copy its mock data, canned timing behavior, fake agent output, or local-only collaboration model back into production.

## Repository map

```text
app/                         Next App Router pages and API route handlers
  access-auth.ts             Reads trusted Worker-provided identity
  api/                       Authenticated application interfaces
  home/                      Member session list and creation
  join/                      Authenticated invite preview and acceptance
  session/                   Lobby and Agent Floor routes
  styles/                    Tokens, layout, product, and restored floor styles
components/product/          Page-level product screens
  RepositoryCard.tsx         Member-visible repository state and owner-only GitHub setup controls
components/session/          Agent Floor workspace components and client data source
db/
  schema.ts                  Drizzle schema source
  sessions.ts                Prepared D1 user/session/member/invite queries
  floor.ts                   Prepared D1 floor snapshot and mutation queries
  repositories.ts            Owner-gated GitHub connection and check-command persistence
  preflights.ts              Durable preflight/check state and internal Workflow transitions
  runs.ts                    Durable agent-run lifecycle, checks, files, artifacts, and execution context
drizzle/                     Generated D1 migrations and metadata
lib/
  floor-types.ts             Public persisted floor types
  session-types.ts           Session, identity, presence, and typing event types
  validation.ts              Bounded input parsing and normalization
  identity.ts                Access verification and local identity isolation
  invites.ts                 HMAC signing and constant-time verification
  github.ts                  GitHub App JWT, installation-token, repository, and branch reads
  github-state.ts            Signed callback state and webhook HMAC verification
  runtime-token.ts           Short-lived preflight/run operation-scoped gateway JWTs
  presence-server.ts         Internal application-to-Durable-Object notifications
  floor-api.ts               Shared floor route response helpers
  floor-state.ts             Pure queue/mention/revision client helpers
  typing-drafts.ts           Pure live-draft reducers and visibility selection
worker/
  index.ts                   Cloudflare entry, identity boundary, assets, app dispatch
  presence.ts                Authenticated WebSocket route and SessionPresence object
  preflight-workflow.ts      Durable exact-source Sandbox preflight orchestration
  agent-run-workflow.ts      Durable Codex/check/cancellation Sandbox orchestration
Dockerfile.sandbox           Version-matched Cloudflare Sandbox runtime image
.github/workflows/deploy.yml Push-to-main production deploy (test → migrate → build → deploy)
scripts/codex-runner.mjs     Pinned server-side Codex SDK runner inside the Sandbox image
scripts/publish-bundle.mjs   Fixed trusted bundle/ref/ancestry/file/object validation and non-force publication
tests/
  unit/                      Pure functions, validation, identity, signing, reducers
  worker/                    Local D1 and Durable Object integration tests
  render/                    Built Worker/server-rendering and route behavior
  e2e/                       Two authenticated browser-context product flow
docs/agent-backend-gaps.md   Deferred execution/repository capabilities
docs/cloudflare-access-branding.md  Manual Zero Trust login/App Launcher branding steps
docs/github-production.md    Production GitHub App, Access, secrets, migration, and deploy runbook
wrangler.jsonc               Production bindings, routes, migrations, compatibility
```

## Local development

### Requirements

- Node.js 22.13.0 or newer.
- npm.
- A Cloudflare-compatible Wrangler runtime installed through project dependencies.

### First setup

```bash
npm install
cp .env.example .dev.vars
openssl rand -hex 32
```

Put the generated value in `.dev.vars` as `INVITE_SIGNING_SECRET`. Choose local `OPENFLOOR_DEV_USER_*` values. Access placeholders may remain for loopback development.

Apply migrations and start:

```bash
npx wrangler d1 migrations apply openfloor-production --local
npm run dev
```

Open the printed URL, normally `http://localhost:3000`, then use `/home`. Do not add `/app` in development.

### Testing multiple local users manually

The normal development fallback supplies one server-side identity. The automated Playwright suite is the supported repeatable two-user test because it enables test-only identity headers in an isolated environment. Do not expose that test mechanism in production to make manual testing easier.

### Useful commands

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:migrations
npm run test:worker
npm run test:render
npm run test:e2e
npm test
npm run build
```

`npm test` is the required comprehensive pipeline.

## Testing strategy

### Unit tests

Use for pure behavior:

- Identity claim parsing and development fallback isolation.
- Invite signing and verification.
- GitHub callback-state signing, expiry/one-time consumption, and webhook HMAC verification.
- Validation and normalization.
- Date formatting that is deterministic across server and browser.
- Queue merge selection, mentions, and revision decisions.
- Presence and typing-draft reducers.
- Everyone/Typing/Hidden draft selection.

### D1 integration tests

Use the Cloudflare Vitest worker pool and local migrations to test:

- User upserts.
- Session creation and member-only listing.
- Membership uniqueness and concealment.
- Invite acceptance, rotation, and revocation.
- Owner/non-owner leave behavior.
- Empty new floor snapshots.
- Agent uniqueness and same-session ownership.
- Assignment, message, DM privacy, queue, ordering, and merging behavior.
- Revision increments and persistence after reread.
- Owner-only repository setup/disconnect, member reads, outsider concealment, and ordered required-check persistence.
- Candidate uniqueness, webhook delivery deduplication, behind-base reconciliation, and external candidate mutation detection.
- Preflight uniqueness, ordered state recovery, terminal failure/timeout state, gateway-token binding, and R2 log authorization.

### Durable Object tests

Cover:

- Authenticated upgrade and unauthorized rejection.
- Two-user presence.
- Multiple-tab online deduplication.
- Disconnect behavior.
- Hibernation restoration.
- Member, session, and floor notifications.
- Ephemeral draft broadcast.
- Draft restoration after hibernation.
- Multiple-tab draft aggregation and fallback when one tab closes.

### Rendering tests

Build the Worker and verify:

- Public landing content.
- Protected redirects.
- Product metadata.
- Authenticated empty floor rendering.
- Absence of seeded agents, prompts, files, checks, or branches.
- Presence of current floor controls without relying on client-only mounting.
- Nothing is served outside the configured base path in the production build.

### End-to-end tests

The Playwright test uses two authenticated browser contexts and verifies the real flow:

- Owner creates a session and shares an invite.
- Member explicitly joins.
- Both see presence and enter the floor.
- Objective edits synchronize.
- Agent, prompts, assignments, team chat, and DMs persist and synchronize.
- Queue targeting and merging work.
- Live teammate draft text appears in realtime.
- Typing, Everyone, and Hidden draft modes behave correctly.
- Review stays empty without fabricated repository data.
- Signed GitHub webhook rejection/acceptance and the owner/member repository connection, candidate synchronization, passing/failing preflights, real-output viewing, retry, and reload recovery through deterministic test-only GitHub/Workflow/Sandbox adapters.
- Reload persistence, disconnect/reconnect, leave, and roster updates work.

When adding a collaborative feature, prefer extending this two-context flow over testing only one browser.

### Hydration and time formatting

Server-rendered text must be deterministic. Do not render `Date.now()`, `Math.random()`, browser-locale-only formatting, or server/client branches into shared initial markup. Use the helpers in `lib/date-format.ts` or pass an explicit server snapshot. The project previously encountered hydration mismatch from locale/date differences; tests should guard any new timestamp presentation.

Viewer-local timestamps are shown through `components/LocalDateTime.tsx`: it renders the deterministic UTC form on the server and on the first client render, then swaps to the host-timezone `formatShort*Local` variants after mount. Use it for any user-facing timestamp instead of calling the local formatters during render.

## Production configuration and deployment

### Required bindings

Defined in `wrangler.jsonc`:

- `DB`: D1 database `openfloor-production`.
- `SESSION_PRESENCE`: `SessionPresence` Durable Object.
- `ASSETS`: built client assets.
- `IMAGES`: Cloudflare Images transform binding.
- `REPOSITORY_PREFLIGHT`: Cloudflare Workflow binding.
- `AGENT_RUN_WORKFLOW`: Cloudflare Workflow binding.
- `SANDBOX`: Cloudflare Sandbox Durable Object/container binding.
- `PREFLIGHT_LOGS`: private R2 bucket `openfloor-preflight-logs`.

The phased GitHub rollout currently uses the existing production Worker and D1 database. GitHub App setup and deployment are documented in `docs/github-production.md`. Until the user establishes staging, install the App only on the disposable acceptance repository and complete each phase's browser acceptance before expanding repository access.

Cloudflare Containers requires a Workers Paid account. `PREFLIGHT_ENABLED` is the production rollout gate: production is enabled only after the container image, `SANDBOX`, and `REPOSITORY_PREFLIGHT` bindings deploy successfully. While disabled, the UI omits **Verify runner** and the start endpoint returns `503`; repository connection and candidate reconciliation remain available. Tests explicitly enable the deterministic test adapter.

`AGENT_RUN_ENABLED` independently gates Phase 4. Production is enabled only after the updated image and Workflow deploy and `OPENAI_API_KEY` is configured; while false the UI omits **Run** and direct starts return `503`. Tests enable only the deterministic test adapter.

Durable Object migration `v1` registers `SessionPresence`; `v2` registers `Sandbox`. Keep migration syntax compatible with the pinned Wrangler version.

### Required secrets

- `INVITE_SIGNING_SECRET`
- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`
- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_STATE_SECRET`
- `GITHUB_WEBHOOK_SECRET`
- `RUNTIME_GATEWAY_SECRET`
- `OPENAI_API_KEY`

Set a secret by its variable name, then enter the value when prompted:

```bash
npx wrangler secret put INVITE_SIGNING_SECRET
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

Do not pass the secret value as the `wrangler secret put` name. Never commit `.dev.vars`, Access credentials, signing secrets, tokens, or generated invite URLs.

### Deployment order

```bash
npm test
npx wrangler d1 migrations apply openfloor-production --remote
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

Migrations must land before code that requires them. The build generates `dist/server/wrangler.json`; deployment uses that built config.

Pushes to `main` run this exact sequence automatically via `.github/workflows/deploy.yml` (GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`); merging to `main` is the deploy authorization. Production Cloudflare credentials are step-scoped to migration and deployment and must never be exposed to dependency installation, tests, or builds. The manual sequence above remains for emergencies and for changes GitHub Actions cannot see (secrets, Access policy).

### Smoke test after deployment

1. Open public `https://opnflr.com/app` without an Access session.
2. Sign in through a protected path and verify return to `/app/home`.
3. Create a session and confirm it starts empty.
4. Open a second authenticated browser identity and accept an invite explicitly.
5. Verify lobby and floor presence.
6. Verify a live draft appears and its three viewing modes work.
7. Create an agent and confirm it persists after reload.
8. Add unassigned and targeted queue prompts; reorder or merge them.
9. Send team and direct messages and verify DM privacy.
10. Edit the objective and verify cross-browser update and reload persistence.
11. Rotate and revoke the invite; verify old links reveal nothing.
12. Verify Review is empty and contains no fabricated files/checks.
13. Verify sign-out through Cloudflare Access.

## Engineering conventions

### Database and API work

- Keep authorization close to the database operation; UI hiding is not authorization.
- Use prepared D1 statements and bound values for runtime SQL.
- Group logically atomic mutations and revision bumps in `database.batch`.
- Validate and normalize at the API boundary before querying.
- Preserve 404 concealment for non-members and unauthorized owner-only resources.
- Return the authoritative resource or snapshot from successful mutations.
- Add indexes for actual lookup/order patterns.
- Preserve prompt authorship during queue operations.
- Treat a cross-session ID as invalid, even if that ID exists elsewhere.

### Realtime work

- Authenticate and authorize before forwarding to the Durable Object.
- Trust the socket attachment identity, never a user ID in a client message.
- Use the hibernating WebSocket API and serialized attachments.
- Avoid intervals in the Durable Object.
- Design for multiple tabs per user.
- Keep event payloads bounded and typed.
- Use D1 revisions for persisted reconciliation.
- Add hibernation and reconnect tests for protocol changes.

### Frontend work

- Derive people, names, roles, ownership options, and avatars from real session members.
- Render absent runtime/review fields as absent.
- Keep client data sources asynchronous and treat mutation responses as authoritative.
- Surface inline failures; do not silently pretend a mutation succeeded.
- Preserve the empty first-run experience.
- Keep panel behavior and responsive layout working when collections are empty or large.
- Do not add input placeholder examples that appear to be product data.
- Do not introduce fake status transitions to make the UI look active.

### Security and privacy

- Never trust forwarded identity headers directly from the public request.
- Never expose invite signing secrets or Access tokens to the client.
- Never log live prompt drafts or store them in analytics by default.
- Remember that team messages are visible to the room, while DMs are filtered per caller.
- Treat live drafts as sensitive room content visible to authenticated members.
- Preserve invalid-invite and non-member metadata concealment.

### Git and change hygiene

- Preserve unrelated worktree changes.
- Do not commit `.dev.vars`, build output, Wrangler state, Playwright artifacts, or `tsconfig.tsbuildinfo`.
- Do not modify the preserved demo snapshot branch as part of normal feature work.
- Keep migrations, schema, tests, docs, and code in the same logical change.
- Do not push, deploy, rotate secrets, or mutate production unless the task explicitly authorizes it.

## Known limitations and footguns

- The database provider-identity column is still named `chatgpt_user_id`; it is not ChatGPT-specific anymore.
- Production uses `/app`; local development does not. Manual paths are a common source of broken links and sockets.
- Next `Link` and manual `fetch` have different base-path responsibilities.
- Cloudflare Access configuration is external state; code passing locally does not prove the production policy paths are correct. The hosted login screen's branding is dashboard-applied too — steps in `docs/cloudflare-access-branding.md`.
- The Worker route `opnflr.com/app*` is intentionally broader than `/app/*` due query-string routing behavior.
- Access protects the app at the edge, but the Worker still verifies JWTs. Do not remove defense in depth.
- `/app/webhooks/github` is deliberately public and must never process a payload before its raw-body HMAC and size are verified.
- Candidate naming never accepts a complete Git ref. Contents write creates only the server-generated `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>` ref; no generic branch CRUD, force push, base write, protection change, or arbitrary deletion is exposed.
- Phase 3 source checkout proxies an exact GitHub archive through `/runtime/preflight/source`; the Sandbox receives only a short-lived source-only JWT, never the GitHub installation token.
- `@cloudflare/sandbox` and `cloudflare/sandbox` are pinned together at `0.12.7`. Docker must be running for local development and deploys that build the container image.
- The production preflight gate was enabled after the Workers Paid upgrade and successful container-enabled deployment. Do not expose **Verify runner** against missing runtime bindings in another environment.
- Preflight output is bounded before R2 persistence and combined log responses are capped; large logs and secrets must never be written to D1.
- Set `GITHUB_APP_PRIVATE_KEY` by piping the complete downloaded PEM file into `wrangler secret put`; an App installation redirect can succeed even when this key is malformed, but repository discovery cannot. The GitHub client accepts both GitHub's PKCS#1 `RSA PRIVATE KEY` download and PKCS#8 `PRIVATE KEY` PEM formats.
- Floor snapshots are caller-specific because of DM filtering.
- Realtime `floor.changed` is a refetch signal, not the changed records themselves.
- Draft Hidden mode does not stop outbound sharing.
- Agent names may contain spaces, while the current `@mention` helper recognizes a single word-like name. Explicit target selection is the reliable path for multiword agent names until mention parsing is redesigned.
- Owners cannot leave because ownership transfer is deferred.
- Review is derived from the latest active or merged candidate, its bounded GitHub PR snapshot, and retained real run attribution; complete artifacts remain outside the snapshot.
- The UI contains restored visual affordances from a prototype; verify backend wiring before claiming any action is real.
- Wrangler is pinned. A newer compatibility date may be rejected until Wrangler is upgraded deliberately.
- This `AGENTS.md` is the comprehensive context source; keep shorter README and focused docs consistent with it.

## Roadmap guidance

Repository execution Phases 1–7 are implemented. Future milestones should focus on deployment integrations, resolving the separately tracked manual-discard issue without weakening its lease, and broader agent lifecycle/product work rather than expanding GitHub permissions casually.

## Key decision log

### 2026-08-19 — Pushes to main deploy production via GitHub Actions

**Decision:** `.github/workflows/deploy.yml` runs the documented deploy sequence — `npm test`, `wrangler d1 migrations apply DB --remote`, `npm run build`, `wrangler deploy --config dist/server/wrangler.json` — on every push to `main`, serialized by a `production-deploy` concurrency group that never cancels in-flight runs. Auth comes from repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; Worker runtime secrets stay in Cloudflare and are untouched by CI.

**Rationale:** The runbook was four commands executed by hand, so production lagged merged work and depended on someone remembering the order (migrations before code). Encoding the same sequence in CI changes when it runs, not what runs. GitHub Actions over Cloudflare Workers Builds because the pipeline lives in the repo, is reviewable, and needs no dashboard state beyond two secrets.

**Consequences:** Merging to `main` is deploying — the full test pipeline still gates it, but a red deploy job means production did not pick up the merge; check the Actions log. Migrations apply before build/deploy, same as the manual order. The e2e step installs Playwright chromium in CI; the sandbox container image builds on the Actions runner's Docker. The job has read-only repository permission, and Cloudflare secrets exist only on the migration and deploy steps so install scripts, tests, and builds cannot read them. Rotating the API token happens in GitHub repo secrets, not in code.

### 2026-08-19 — Two themes from one token sheet

**Decision:** The cream palette is the light theme; a warm-charcoal dark theme overrides the color tokens in `tokens.css` — once under `prefers-color-scheme: dark` (system default) and once under `[data-theme="dark"]` (manual override), kept identical. A ThemeToggle in both headers cycles System → Light → Dark, persisted per device in localStorage and applied pre-paint by an inline script in the root layout. The code workbench's inverse surfaces and the identity tints stay unchanged in both themes.

**Rationale:** Every color already resolves through `tokens.css` (the components had no literal colors worth keeping except the workbench's), so a theme is one override block, not a rewrite. System-following alone was not enough — people demo on projectors and override their OS.

**Consequences:** New colors must be tokens with values in all three blocks. The two dark blocks must stay byte-identical. Theme choice is per-device local state, never synced.

### 2026-08-19 — Retention purges only ended sessions, on a daily cron

**Decision:** A `triggers.crons` entry plus a thin Worker `scheduled()` export runs `purgeExpiredSessions` daily, hard-deleting repository-free sessions whose `ended_at` is older than 30 days (`ENDED_SESSION_RETENTION_MS`) and notifying their presence objects. Owners can also hard-delete repository-free sessions immediately via `DELETE /api/sessions/[id]`. Never-ended sessions and sessions with repository state are not purged automatically.

**Rationale:** "Automatic delete with an expiration timer" needs a background trigger, not a read-path side effect (a lazy sweep in `listSessionsForUser` deletes as a side effect of reads and never runs for idle users; a DO alarm is per-session machinery for a global batch job). Ended-only purging avoids silently destroying a live room someone may return to. Cascade foreign keys make deletion a single statement.

**Consequences:** `wrangler.jsonc` owns the schedule; the logic stays in the testable db helper. Manual deletion and retention fail closed when a repository connection exists because D1 contains the expected-SHA leases and audit state required to clean GitHub branches, Workflows, and private R2 safely. A future durable deletion workflow may supersede this restriction; until then, do not bypass it with cascading SQL. If sessions ever need purge-by-inactivity, it is one more constant and an `OR` clause in the guarded statement.

### 2026-08-19 — Sessions end with a timestamp, not a status enum

**Decision:** Session lifecycle is a nullable `sessions.ended_at` set by an owner-only idempotent `POST /api/sessions/[id]/end`. Ending revokes the active invite in the same batch, broadcasts `session.ended`, and makes collaboration plus owner repository/preflight/run/review mutations return `409` through `getActiveMembershipRole`; route checks run before external calls and floor SQL rechecks `ended_at IS NULL` inside its mutation batch. Reads, leaving, cancellation, and presence connections keep working. There is no un-end in v1.

**Rationale:** The purge/retention work needs the timestamp anyway (precedent: `revoked_at`, `disconnectedAt`); a single write-only guard at the membership choke point beats per-route checks; `409` instead of `404` because clients treat `404` as membership loss and kick to `/home`; keeping sockets open preserves read access and avoids a pointless reconnect loop since `authorizePresence` is membership-based.

**Consequences:** New user-triggered mutating db helpers must authorize with `getActiveMembershipRole`, not `getMembershipRole` (reads and explicit cancellation keep the latter). Mutations that can race ending must also include `ended_at IS NULL` in the same D1 batch or conditional statement; an earlier authorization read alone is insufficient. Ended sessions remain fully readable until an eligible repository-free retention purge deletes them.

### 2026-08-18 — Preserve the original prototype

**Decision:** Preserve the complete demo on `codex/demo-ui-snapshot` at commit `5958f34` before replacing it.

**Rationale:** The visual and interaction language remained useful, but the mock architecture was not safe to evolve into a real product.

**Consequences:** Engineers may consult the snapshot for UI reference. Production code must not import or recreate its mock fixtures, delayed replies, fake typing, terminals, or canned reviews.

### 2026-08-18 — Use Cloudflare as the primary platform

**Decision:** Deploy the product as a Cloudflare Worker with D1 and a per-session Durable Object rather than moving the application to Vercel or reducing presence to polling.

**Rationale:** The application needs edge authentication, relational persistence, hibernating room WebSockets, and a natural one-object-per-session coordination model.

**Consequences:** Cloudflare bindings, migrations, Access policy, Worker routes, and Wrangler build/deploy behavior are part of the application architecture and test strategy.

### 2026-08-18 — Replace the earlier ChatGPT sign-in design with Cloudflare Access

**Decision:** Use Cloudflare Access with Google and One-time PIN. Do not own an application callback or password flow.

**Rationale:** The actual deployment is a Cloudflare-hosted product with Access available, and the platform-provided ChatGPT sign-in endpoint was not available on the custom domain.

**Consequences:** Access subject is the stable provider identity. The legacy `chatgpt_user_id` column remains but is semantically generic. Protected production paths must stay synchronized with Access configuration.

### 2026-08-18 — Mount the product under `/app`

**Decision:** Keep the marketing site at the apex and serve OpenFloor under `opnflr.com/app` in production; serve at root in local development.

**Rationale:** Marketing and product are separate deployments on one domain, and vinext development stylesheet behavior does not tolerate the production prefix cleanly.

**Consequences:** Next base-path configuration, manual `BASE_PATH` use, Worker asset stripping, Access paths, invite URLs, WebSocket URLs, tests, and smoke tests must all preserve the distinction.

### 2026-08-18 — D1 is authoritative for collaboration

**Decision:** Persist sessions, membership, invitations, objective, agents, assignments, messages, and queue state in D1. New floors are empty.

**Rationale:** Collaboration must survive reloads and be shared across users. Mock React state could not satisfy that requirement.

**Consequences:** Floor mutations return snapshots, use revision increments, and are tested with local D1 migrations. No production fixture arrays are allowed.

### 2026-08-18 — Use signed reusable invitations

**Decision:** Represent invite tokens as `invite-id.HMAC-SHA256-signature`, keep one active invite per session, and store no bearer secret in D1.

**Rationale:** Owners need to retrieve and reuse the current link while retaining rotation and revocation without storing a plaintext bearer token.

**Consequences:** `INVITE_SIGNING_SECRET` is required. Rotation revokes the old record. Invalid or revoked tokens reveal no preview.

### 2026-08-18 — Durable Object presence is ephemeral and membership-gated

**Decision:** Use one hibernating `SessionPresence` object per session. The Worker authenticates and verifies D1 membership before WebSocket handoff.

**Rationale:** Room presence needs low-latency fanout, tab deduplication, and hibernation without weakening authorization.

**Consequences:** D1 remains the membership authority. Socket attachments contain trusted internal identity. Polling is not the fallback architecture.

### 2026-08-18 — Restore the full floor shell without restoring simulation

**Decision:** Reuse the prototype's workspace, panels, queue, team, composer, and review layout while removing terminals, fake agent output, mock files, timers, canned replies, and fixtures.

**Rationale:** The interaction design was valuable, but fabricated activity made it impossible to distinguish product capability from presentation.

**Consequences:** The UI remains ready for future runtime/review data but must show empty states until that data is real.

### 2026-08-18 — Synchronize persisted floor data by revision and refetch

**Decision:** Increment a session-level `floor_revision` on every successful floor mutation, broadcast changed domains through the Durable Object, and let older clients refetch the authoritative snapshot.

**Rationale:** D1 should remain the single source of truth while the WebSocket provides efficient invalidation.

**Consequences:** Events do not need to duplicate full persisted records. Mutations and revision increments stay in one batch. Clients ignore stale revision events.

### 2026-08-19 — Live prompt drafts are realtime but not persisted

**Decision:** Broadcast authenticated teammate prompt drafts through per-socket Durable Object attachments and aggregate by user across tabs. Provide Typing, Everyone, and Hidden local display modes.

**Rationale:** Teams benefit from seeing concurrent intent before submission, but unfinished text should not become durable floor history.

**Consequences:** Drafts clear on submission/navigation/disconnect, are bounded to 4,000 characters, survive Durable Object hibernation only while sockets exist, and never enter D1. Hidden affects local viewing, not outbound sharing.

### 2026-08-19 — Deliver repository execution through accepted end-to-end phases

**Decision:** Build the repository and agent-execution milestone as seven sequential, user-accepted phases. Each phase must introduce a real browser-testable capability, pass the full test pipeline, and stop for explicit acceptance before the next phase begins.

**Rationale:** Repository credentials, remote Git refs, isolated execution, agent-authored code, integration, and merge each expand the product's authority and failure surface. Independent acceptance gates keep every expansion observable, testable, and reversible before more authority is added.

**Consequences:** Phase 1 begins with this workflow rule and may implement only the deployment environment and GitHub connection. Later runtime, branch, review, and merge capabilities must remain absent until their named phase. Each phase must keep this document, the focused gap document, setup instructions, tests, and browser acceptance steps synchronized with what is genuinely implemented. The original isolated-development rollout requirement was superseded on 2026-08-19 by the temporary production-rollout decision below.

### 2026-08-19 — Use one owner-gated GitHub App repository per session

**Decision:** A session may have one durable repository connection selected through a GitHub App installation. The initiating session owner is bound to a signed, expiring, single-use callback state. Members may read the selected repository, base branch, and ordered required-check commands; only the owner may mutate that configuration. GitHub installation and repository IDs are authoritative, while names are display metadata. The webhook endpoint is public, bounded, and HMAC-authenticated. Phase 1 performs repository and branch reads only.

**Rationale:** A GitHub App provides narrowly scoped, short-lived installation credentials and repository selection without granting user-wide OAuth access. One repository gives each session a single coordination boundary, and owner-only mutation prevents ordinary members from expanding repository or future compute authority.

**Consequences:** The app requests Metadata read, Contents read/write, Pull Requests read/write, Checks read, and Commit statuses read, with no Administration or Workflows permission. The write grants are reserved for later accepted phases; generic branch CRUD, force push, base-branch writes, and protection changes are never exposed. The original isolated-development deployment consequence was superseded on 2026-08-19; phased acceptance now uses production OpenFloor with repository access limited to a disposable repository.

### 2026-08-19 — Target Workflows, Sandboxes, Codex, and a single candidate PR

**Decision:** The accepted target architecture uses Cloudflare Workflows for durable orchestration, Cloudflare Sandboxes for isolated repository work, and the server-side Codex SDK with `gpt-5.6-terra`. Owner-authorized passing runs will eventually publish server-generated run branches, integrate automatically into one active candidate branch, maintain one draft pull request per candidate, and allow only the owner to request the final squash merge.

**Rationale:** Durable workflows provide restart/retry semantics, sandboxes isolate untrusted repository commands, short-lived service credentials keep secrets out of repository processes, and a single candidate PR gives human reviewers one stable integration surface while preserving individual run attribution.

**Consequences:** This entry records the future architecture but does not make later-phase behavior real. Cloudflare Workflow, Sandbox, R2, Codex, branches, checks, run records, pull requests, integration, and merge remain absent until their named accepted phases. GitHub protections remain authoritative and workflow-file changes stay excluded while the App lacks Workflows permission.

### 2026-08-19 — Temporarily deliver repository phases directly to production

**Decision:** Until the user establishes a staging environment, deploy each accepted repository-execution phase to the existing production OpenFloor Worker and D1 database at `opnflr.com/app`. Use a real disposable GitHub repository as the only App installation target during acceptance.

**Rationale:** Reusing the working production application, Access policy, domain, and bindings removes a second environment's DNS, Access, secret, and deployment setup from the critical path. A disposable repository limits the GitHub-side impact while the integration matures.

**Consequences:** The unused `openfloor-development` D1 database may remain for later cleanup but is not referenced by application configuration. Production migrations must precede code deployment. The five GitHub App secrets must be configured before deploying the repository UI, and each phase must still pass the complete pipeline and stop for explicit browser acceptance. Expanding the App beyond the disposable repository requires a separate deliberate decision.

### 2026-08-19 — Allow repository connection before checks are configured

**Decision:** Required-check commands are optional when an owner connects or configures a repository. The connection displays an explicit unconfigured state when the command list is empty.

**Rationale:** Repository authorization and selection are useful independently of knowing the repository's test commands. Requiring commands during connection prevents owners from completing GitHub setup and discovering the repository before deciding how it should be verified.

**Consequences:** The repository API accepts zero to eight commands. Future preflight, agent-run, publication, and integration actions must fail closed until the owner configures at least one command; an empty list must never be treated as a passing check suite.

### 2026-08-19 — Reconcile one immutable candidate ref without automatic repair (branch format superseded)

**Decision:** Enabling execution creates one durable active candidate at the current configured base SHA on a server-generated `openfloor/<session-short>/candidate/<candidate-short>` ref. OpenFloor records expected and observed SHAs, treats GitHub as authoritative, and reports a newer base as behind or an unexpected candidate head as externally modified. It never force-pushes or repairs either condition in Phase 2.

**Rationale:** A single candidate gives later runs a stable integration target while immutable expected SHAs make races and external edits visible. Server-only naming and non-force creation prevent callers from turning the session API into generic Git ref authority.

**Consequences:** Candidate creation and synchronization are owner-only; members receive the state read-only. Candidate creation is reserved durably before the GitHub write and records a failed reservation if the write fails. Signed GitHub deliveries are deduplicated by delivery ID, bump `floor_revision`, and broadcast `repository` and `review` invalidations. Disconnect/reconnect preserves candidate history. Run branches, local execution, candidate updates, pull requests, integration, and deletion remain deferred. The opaque `<candidate-short>` terminal segment was superseded later on 2026-08-19 by the safe-name-plus-ID format; the server-owned prefix and non-force/reconciliation rules remain in force.

### 2026-08-19 — Run exact-source preflight in durable isolated infrastructure

**Decision:** Owner-started repository preflight runs through `RepositoryPreflightWorkflow` and a unique Cloudflare Sandbox at the recorded candidate SHA. `@cloudflare/sandbox` and its container image are pinned together at `0.12.7`; the future Codex SDK is pinned at `0.148.0`. D1 stores bounded authoritative preflight/check state, while private R2 stores bounded logs.

**Rationale:** Workflows provide restart-safe step identity and retries, Sandboxes isolate repository-controlled commands, and separating summaries from logs keeps floor snapshots bounded. Snapshotting the SHA and ordered commands makes a recovered job execute the same input rather than silently following GitHub or configuration changes.

**Consequences:** Verify runner is owner-only and fails closed without a ready unmodified candidate and at least one configured command. The Sandbox receives a ten-minute JWT limited to one preflight, session, repository, SHA, and `source` operation; the trusted Worker gateway mints the GitHub installation token and streams the exact archive, so GitHub credentials never enter repository processes. Each command has a ten-minute limit, persisted output is capped, combined log responses are capped, and the Workflow always attempts Sandbox destruction. Preflight never commits or modifies GitHub. Phase 4 may reuse these bindings but must add separate authoritative run records rather than overloading preflight history.

### 2026-08-19 — Gate preflight until Cloudflare Containers is available

**Decision:** Production keeps `PREFLIGHT_ENABLED=false` until the account has Workers Paid/Containers access and the Phase 3 container-enabled deployment succeeds. The false gate removes the owner action from the rendered repository card and rejects direct preflight starts with `503`.

**Rationale:** A Worker version can deploy before its container image is publishable, which would otherwise expose an action backed by missing Sandbox and Workflow bindings. The gate preserves honest product behavior and keeps the accepted Phase 2 repository flow operational during infrastructure setup.

**Consequences:** The Workers Paid upgrade, container deployment, and Phase 3 browser acceptance succeeded on 2026-08-19, so production sets the flag to `true`. Other environments must keep it disabled until their own runtime bindings are live. Automated tests explicitly enable preflight and continue to exercise deterministic Workflow/Sandbox behavior without weakening production checks.

### 2026-08-19 — Execute Codex locally before granting GitHub write authority

**Decision:** Phase 4 runs the pinned server-side Codex SDK `0.148.0` with model `gpt-5.6-terra` inside a unique Cloudflare Sandbox checked out at the recorded candidate SHA. `AgentRunWorkflow` owns orchestration and cancellation. One active run is allowed per queue item, owner actions start/cancel compute, and passing changes remain local rather than being pushed to GitHub.

**Rationale:** This makes genuine code generation, required checks, recovery, and review observable before introducing remote branch writes. Durable records separate run lifecycle from preflight history, while an isolated writable workspace contains repository-controlled code and commands.

**Consequences:** The Worker supplies exact source through a run-scoped source JWT and proxies Codex Responses requests through a separate short-lived run-scoped JWT, injecting `OPENAI_API_KEY` only at the trusted boundary. The Sandbox and repository process never receive GitHub installation or OpenAI project credentials. D1 stores bounded run/check/file summaries; R2 stores bounded complete logs and diffs. Passing items become `blocked` pending Phase 5 publication, failures and cancellations are retryable, and workflow-file changes are rejected.

### 2026-08-19 — Gate production agent execution independently

**Decision:** `AGENT_RUN_ENABLED` remains false until the Phase 4 image and Workflow are deployed and `OPENAI_API_KEY` is configured in that environment.

**Rationale:** Repository connection and preflight should remain available during a partial rollout, while an owner must never see an execution action backed by missing credentials or runtime bindings.

**Consequences:** The rendered Run control is absent and direct starts return `503` while disabled. Deterministic tests explicitly enable their test adapter. The production image, Workflow, and secret were verified on 2026-08-19, so production now enables the flag for Phase 4 browser acceptance.

### 2026-08-19 — Preserve every passing run on an independently verified branch

**Decision:** Phase 5 automatically publishes every passing owner-authorized run to a unique server-generated `openfloor/<session-short>/run/<run-short>` branch. The agent Sandbox exports a bounded incremental Git bundle and receives no GitHub credential. A separate clean publisher Sandbox validates the bundle against the exact candidate tree and recorded file set, constructs one commit whose parent is the candidate SHA, pushes without force using a repository-limited installation token, and reconciles the returned GitHub SHA before marking the run published.

**Rationale:** Phase 4 intentionally destroyed local workspaces, which made consecutive successful prompts appear to replace one another. Independent verified branches preserve every result and its attribution without prematurely combining unreviewed changes. A clean publisher prevents repository processes from gaining GitHub write credentials or controlling the validation commands.

**Consequences:** D1 records local/published/remote SHAs, run branch, bundle metadata, publication time, and discard audit data; bounded bundles remain private in R2. Validation permits exactly one generated ref and result commit, requires the reconstructed archive tree to equal the candidate tree, compares the complete changed-path set, rejects workflow files, and caps files, objects, individual object size, and total object size. Queue items remain blocked until Phase 6 integration. Review shows the latest real run while every run branch remains visible beside its queue item.

### 2026-08-19 — Delete run branches only with an expected-SHA lease

**Decision:** Owner-only discard first reconciles the remote run head and then deletes through a fixed Git push using `--force-with-lease` for the recorded SHA. OpenFloor never exposes arbitrary ref deletion and never deletes a candidate or base branch through this action.

**Rationale:** GitHub's REST ref deletion endpoint has no conditional expected-SHA parameter, leaving a race between read and delete. A Git lease makes the remote head comparison atomic with deletion.

**Consequences:** External push webhooks update each run's observed remote SHA. Any mismatch, missing branch, wrong status, non-OpenFloor ref, or lease failure returns a conflict and preserves the branch. Successful discard deletes only the GitHub ref; all run, check, file, diff, bundle, event, and attribution records remain durable.

### 2026-08-19 — Resume publication from durable bundle state

**Decision:** GitHub installation tokens authenticate Git-over-HTTPS as the password for the fixed `x-access-token` username, encoded as an HTTP Basic authorization header that is never written into the repository URL. A restarted run Workflow detects `publishing` and resumes validation/publication from its stored bundle, recorded files, and local commit instead of rerunning Codex or checks.

**Rationale:** GitHub's REST API accepts Bearer tokens, but its documented Git transport uses the installation token as an HTTP password. Publication is a distinct recoverable stage, and repeating paid agent execution after a transport or deployment failure would be slow and could produce different code.

**Consequences:** Each Workflow instance receives a distinct publisher Sandbox identity so a recovery cannot reuse a stale container image. The clean publisher and discard Sandbox receive the short-lived Git credential only through their process environments; Git clone, push, and conditional deletion all use the same HTTP Basic transport contract, while REST calls continue to use Bearer authentication. Error messages never include the header or token and distinguish an actual expected-SHA lease mismatch from authentication or transport failure. Publication retries remain idempotent because an existing run ref is accepted only at the exact trusted commit, and the Workflow reconciles the remote SHA before recording success.

### 2026-08-19 — Serialize run integration into one candidate and draft PR

**Decision:** After publication, `AgentRunWorkflow` acquires a conditional D1 lease on the active candidate, reconciles the current base/candidate/run refs from GitHub, and requests GitHub's non-force branch merge using the immutable run commit as the head. The first successful integration creates one draft PR from candidate to configured base; later integrations advance that same branch and PR. A GitHub merge conflict records `conflicted`, preserves both branches, and owner-only retry creates a new run attempt from the latest candidate.

**Rationale:** Per-run branches isolate concurrent agent work, while a single serialized candidate gives reviewers one stable integration surface. The D1 lease prevents two Workflows from updating the expected candidate head concurrently, and GitHub remains authoritative for the actual merge result and conflict decision.

**Consequences:** Candidate records persist the integration lease and PR number/node/URL/state/draft metadata. Runs persist integration base, integrated candidate SHA, conflict reason, and timestamps. Successful integration marks the queue item completed; conflict leaves it blocked. Candidate push webhooks received while the matching lease is held do not falsely mark OpenFloor's own merge as an external mutation. Final PR readiness, protection enforcement, squash merge, and cleanup remain Phase 7.

### 2026-08-19 — Allow concurrent runs to publish from an ancestral candidate

**Decision:** Trusted bundle publication no longer requires the remote candidate head to equal the run's pinned candidate SHA. It requires the pinned SHA to exist and remain an ancestor of the observed candidate head, reconstructs and validates the bundle against that exact pinned tree, and publishes the immutable run commit with the pinned SHA as parent. Integration separately requires a ready repository connection and merges the run against the latest serialized candidate.

**Rationale:** Two agents may start from the same candidate. If the first integrates before the second publishes, equality is expected to fail even though the second result is still valid and safely attributable. An ancestry check distinguishes ordinary forward candidate progress from rewritten or unrelated history.

**Consequences:** Concurrent nonconflicting runs can both publish and integrate. A conflicting later run reaches GitHub's authoritative merge conflict path instead of failing prematurely during publication. Force-rewritten ancestry and externally modified repository state still fail closed. The trusted publisher sandbox ID includes an explicit image-generation prefix; increment it whenever publisher image contents change so recovery cannot attach to a container from an older image rollout.

### 2026-08-19 — Make GitHub authoritative for final review and squash merge

**Decision:** The latest active or merged candidate owns a bounded persisted snapshot of its GitHub PR files, check runs, commit statuses, head/base SHAs, draft state, mergeability, and merge-requirement state. Only the session owner may mark the PR ready or request merge. Merge is always squash, supplies the exact recorded candidate SHA, and proceeds only for an open non-draft PR whose head/base still match and whose GitHub state is clean, mergeable, and passing all observed checks.

**Rationale:** D1 must support reloads and member-visible review without pretending to be the repository, while GitHub protection, review, status, and merge decisions must remain authoritative. An expected-head squash request closes the race between review and merge without granting branch-administration or workflow permissions.

**Consequences:** Confirmed merges transition the candidate to durable `merged` history and record the squash SHA. Cleanup verifies every server-generated run/candidate ref and deletes only exact matches with Git `--force-with-lease`; changed refs are retained and cleanup is marked partial. Run cleanup uses `branch_deleted_at`, distinct from manual discard. A merged candidate no longer participates in the live-candidate unique index, and the next owner-started run creates a new candidate from the current base. No generic ref CRUD, force update, protection mutation, alternate merge method, or administration permission is exposed.

### 2026-08-19 — Give candidates durable owner-facing names and descriptions

**Decision:** Each candidate stores a bounded name and description. The enable-execution form defaults them from the session title and objective, the name becomes a sanitized segment inside the server-owned candidate ref, and the first draft PR uses the stored name and description as its title and body. Automatically created later candidate cycles use the current session title and objective.

**Rationale:** Reviewers need candidate branches and pull requests to reflect the session's work instead of opaque IDs or generic repository text, while accepting a complete user-provided ref would weaken the existing branch-ownership boundary.

**Consequences:** Candidate refs now have the form `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>`. Names are NFKC-normalized and limited to 100 characters; descriptions are trimmed and limited to 2,000. Existing candidates are backfilled from their session title/objective. Members can read the metadata, only owners create candidates, and OpenFloor still controls the prefix, suffix, non-force creation, reconciliation, merge, and cleanup rules.

## How to record the next decision

Append an entry using this structure:

```markdown
### YYYY-MM-DD — Short decision title

**Decision:** What is now true.

**Rationale:** Why this option was chosen over the relevant alternatives.

**Consequences:** What code, data, operations, security, testing, or future work must now account for.
```

Also update any earlier sections made inaccurate by the decision. A log entry alone is not enough if setup instructions, route tables, invariants, or the current product boundary changed.

## Definition of done

Before handing off a change, verify the applicable items:

- Product behavior uses real authoritative data or an honest empty state.
- Server authentication and session authorization are enforced.
- Non-member and invalid-resource concealment is preserved.
- Input is bounded, normalized, and tested.
- Cross-session references are rejected.
- Schema and migration are synchronized if persistence changed.
- Persisted floor mutations bump revision and notify the correct domains.
- Realtime behavior handles reconnect, multiple tabs, and hibernation where applicable.
- SSR markup is deterministic and hydration-safe.
- Empty, error, and responsive UI states still work.
- Unit, worker, rendering, and two-user browser tests cover the risk.
- `npm test` passes.
- `README.md`, `docs/agent-backend-gaps.md`, and this file are updated where relevant.
- New durable decisions are appended to the decision log.
- No secrets, local environment files, build output, or test artifacts are included.
- Deployment and production mutation occur only with explicit authorization. Merging to `main` is that authorization: it triggers the automatic production deploy. Agents still never run manual deploys or mutate production state directly without being asked.

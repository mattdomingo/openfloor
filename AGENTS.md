# openfloor Engineering Guide

This file is the authoritative repository-level guide for engineers and coding agents working on openfloor. It applies to the entire repository unless a more specific `AGENTS.md` is added in a subdirectory.

Last verified against `main`: 2026-09-03.

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

Small implementation details do not need a decision-log entry, but this document must stay factually correct. When uncertain, update it. Add new decisions to [`docs/decision-log.md`](docs/decision-log.md), including the date, decision, rationale, and consequences. If a decision supersedes an older one, preserve the history and mark the old entry as superseded rather than silently deleting it — see that file's own instructions for the full-supersession/archive convention.

### Repository-execution milestone delivery protocol

The GitHub repository and agent-execution milestone is delivered one accepted phase at a time. Every phase must:

1. Contain only that phase's documented functionality; do not pre-implement later phases behind hidden UI or dormant production paths.
2. Pass the complete automated test pipeline before handoff.
3. Deploy to the isolated development environment from `release` when its browser acceptance flow depends on GitHub, Cloudflare runtime resources, or OpenAI; promote `release` to `main` only after acceptance.
4. End with browser-based acceptance instructions that exercise the newly real end-to-end behavior.
5. Stop after handoff until the user explicitly accepts the phase.

The implementation plan currently has seven phases: GitHub connection; candidate workspace and reconciliation; sandbox preflight; local Codex candidate generation; run-branch publication; automatic integration and draft pull request; and final review, squash merge, and cleanup. Update this protocol and the decision log if that sequence is deliberately superseded.

## Read this first

Before changing code:

1. Read this file completely.
2. Read `README.md` for the concise setup and deployment path.
3. Read `docs/agent-backend-gaps.md` before touching agent runtime or review concepts.
4. Skim [`docs/decision-log.md`](docs/decision-log.md) for entries relevant to the area you're touching — read it in full only when the change is broad enough to plausibly touch many prior decisions.
5. Inspect the relevant route, database function, public type, client data source, and tests as one unit.
6. Check the worktree with `git status --short`. Preserve unrelated changes.
7. Decide whether the change affects an invariant or decision recorded here or in the decision log. If it does, plan the documentation update with the code change.

The repository intentionally contains a polished UI whose future-facing affordances are broader than the backend implemented today. Never infer that a visible control is backed by an execution system. Trace it to an API and D1 mutation before describing it as persistent or real.

## Product vision

### Ultimate goal

openfloor is a multiplayer coordination environment for teams of humans and software agents working on the same objective.

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

Most agent tools are optimized for one person issuing one prompt to one agent. Real engineering work is collaborative: multiple people divide responsibilities, redirect work, ask each other questions, combine related prompts, watch progress, and review shared outcomes. openfloor is intended to make that multiplayer layer explicit and durable.

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

openfloor has three intentionally separate state classes:

1. **D1-authoritative application state**: users, early-access grants/revocations and waitlist records, Stripe entitlement projections, sessions, memberships, invites, objective, routing settings, agents, assignments, messages, queue items, queue prompts, ordering, candidate merge locks, repository-preview leases, agent-run rollback groups/attempts, merge-conflict cases/attempts/questions, durable private-storage and Sandbox cleanup intents, and floor revision. The early-access Google Sheet is an operations mirror only; Stripe remains authoritative for the external subscription lifecycle; D1 owns the product-facing projection.
2. **Durable Object-coordinated ephemeral state**: online connections and teammate prompt drafts. This state is realtime but is not D1 history.
3. **Local UI state**: selected tabs, panel order and size, collapsed or expanded panels, queue filters, menus, dialogs, the current onboarding step and its unsaved profile/plan inputs, and the local visibility choice for teammate drafts.

Do not persist an ephemeral interaction merely because D1 is available. Do not leave collaborative state local merely because React state is convenient.

### Authorization is enforced on the server

- Every protected server page and every API mutation resolves an authenticated identity on the server.
- Every session-scoped read and write verifies membership in D1.
- Owner-only invite operations verify the `owner` role.
- The WebSocket upgrade is authenticated and membership-checked before the request reaches the Durable Object.
- Client-provided user IDs are never trusted as the acting identity.
- Targets such as agent owners, assignment owners, message recipients, agents, and queue items must belong to the same session.
- A member-created persistent agent is always owned by its authenticated creator. Teammates may edit its task and use Pause/Stop as safety controls, but only the recorded agent owner may change its model/billing choice or resume it. Bulk resume is scoped to the caller's own agents.
- Non-members receive the same not-found response as nonexistent sessions. This concealment prevents metadata enumeration.

### Missing capabilities stay absent

Nullable and empty fields are a deliberate contract, not a temporary rendering bug. UI code must handle absence without inventing defaults. When a future backend is connected, it should provide authoritative data through typed interfaces and explicit mutations.

### Collaboration should survive reloads

Anything presented as durable collaboration must be stored in D1 and returned by the authoritative snapshot. A successful mutation returns the updated snapshot, increments `floor_revision` when it changes floor state, and notifies other clients to refetch.

### Realtime is a coordination signal, not a second database

WebSocket events notify clients about presence or changed domains. D1 remains authoritative for persisted floor data. Except for ephemeral typing drafts, do not turn the Durable Object into a shadow copy of floor records.

## Current product boundary

### Implemented and real

See [`docs/implemented-features.md`](docs/implemented-features.md) for the complete bullet-by-bullet list of what is real today (auth, sessions, agents, GitHub integration, providers, conflict resolution, generated agents, and more). Every entry there is authoritative — nothing in that list is fabricated or aspirational; see "Explicitly deferred" below for what is not yet built.

Repository app preview is implemented but intentionally unavailable while `REPOSITORY_PREVIEW_ENABLED=false`, which remains the reviewed value in production and development. When enabled, the session owner may start, rebuild, or stop one shared 60-minute preview for the exact synchronized candidate; members may view it. D1 owns the lease and three-preview environment cap. A generation compare-and-set prevents stale Workflows from taking over, a prior ready generation stays available during a replacement build or failure, and successful integration or rollback requests a rebuild. Session end, merge, abandonment, repository disconnect/unavailability, external candidate modification, stop, or expiry revokes access. Sandbox cleanup intents survive session deletion and retry through cron.

Preview v1 supports only one JavaScript app at the repository root with exactly one npm, pnpm, Yarn, or Bun lockfile and a nonempty `dev` or `start` script (`dev` wins). Installation suppresses lifecycle scripts and may reach only `registry.npmjs.org` through the outside registry CONNECT proxy. The runtime uses the same credential-free namespace as agent runs: a root setup shell raises private loopback, then setpriv drops all capabilities before the candidate. Exactly one HTTP listener is detected inside the namespace and exposed through a locked Unix socket to a trusted outer TCP relay. Monorepos, multiple services, custom commands, secrets, runtime environment configuration, outbound APIs, and non-JavaScript applications remain unsupported. `REPOSITORY_PREVIEW_ENABLED` remains false until wildcard DNS/TLS and preview Access are accepted.

Exhausted run-branch publication retries are terminal: the run and its queue item become `failed`, the router is notified that capacity is free, and conflict-resolution attempts advance through their normal retry/attention state. A run must never remain indefinitely in `publishing` after its durable Workflow has exhausted retries. Durable Workflow re-entry must treat `integrated`, `conflicted`, `failed`, and `cancelled` runs as finished; `ready` is also finished for a reply or `completion = no_changes` run; other task runs still need publication.

Known production follow-up: the owner discard action still reports failure in the disposable acceptance repository after its Git authentication correction. Preserve the expected-SHA lease and error separation; diagnose this independently rather than weakening deletion safety or folding it into Phase 6.

### Explicitly deferred

- Per-agent reasoning effort (`output_config.effort`). Model selection shipped (creation dialog, closed `PROVIDER_MODELS` allowlist — see the implemented list above); effort is the natural follow-on but a second axis the runners do not thread today.
- Agent-authored chat messages and generic artifact download UI beyond the per-run raw-log expander. (Live run activity streaming and the read-only `openfloor_session_context` mid-run re-read are real — see `docs/agent-backend-gaps.md`.)
- Deployment automation after repository merge.
- Agent ownership transfer (a post-hoc provider switch is delete-and-recreate, not an edit). Task/model/billing edits, and persistent-agent/generated-worker Pause/Stop/Delete, are implemented (`updateFloorAgentSettings`, `db/floor.ts`); generated-agent activation/retirement stays router-controlled and Concierge has no manual lifecycle controls.
- Automatic queue consumption or retry; explicit completion, soft removal, and user-triggered retry are implemented.
- Ownership transfer. Owners cannot leave until transfer exists.
- Persistent draft history. Live prompt drafts are intentionally ephemeral.

See `docs/agent-backend-gaps.md` for the focused backend-gap summary. When any deferred capability becomes real, update both that document and this file.

## User experience and route map

Production owns `app.opnflr.com` at the root, development owns `dev.app.opnflr.com` at the root, and local `npm run dev` is also mounted at the root. `BASE_PATH` is `""` in every environment.

See [`docs/routes.md`](docs/routes.md) for the full production/local route table (path, access level, purpose).

Important behavior: non-members get a concealed 404 (never session details); an owner can't leave (must end the session instead, which is final and idempotent and leaves data readable); ending returns `409` on further mutations, never `404`; join links don't change membership until the user clicks Join; `/signout` is the app's own endpoint, not Cloudflare's. See [`docs/routes.md`](docs/routes.md#important-behavior-route-level-invariants) for the full list, including styling/shell scoping, the `/home/settings?from=` fallback contract, GitHub callback binding, and webhook Access exemption.

## System architecture

The request and synchronization flow is:

```text
Browser
  -> Cloudflare Access on /auth/complete and /api/*; other paths reach Worker
  -> openfloor Worker
       -> verifies Access assertion header or CF_Authorization cookie
       -> or resolves explicit loopback development identity
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
- Cloudflare D1 is the relational database bound as `DB`; production and development bind separate databases.
- `SessionPresence` is a SQLite-backed Durable Object bound as `SESSION_PRESENCE`.
- `RepositoryPreflightWorkflow` is bound as `REPOSITORY_PREFLIGHT`; it durably coordinates exact-source checkout, ordered checks, result persistence, and cleanup.
- `AgentRunWorkflow` is bound as `AGENT_RUN_WORKFLOW`; it durably coordinates exact-source checkout, Codex, required checks, Git-bundle export, trusted publication, reconciliation, cancellation, and cleanup.
- `RepositoryPreviewWorkflow` is bound as `REPOSITORY_PREVIEW`; it durably installs and starts one supported root JavaScript app for an exact synchronized candidate generation, then exposes its one HTTP listener through the preview proxy.
- `Sandbox` is the `@cloudflare/sandbox` Durable Object bound as `SANDBOX`, backed by the matching digest-pinned `cloudflare/sandbox:0.12.7` container image.
- Agent containers isolate the complete provider and every tool in a credential-free mount/PID/network namespace; an outside broker holds scoped gateway/MCP credentials. Trusted publication remains in a separate Sandbox. See the runtime boundary below and `docs/josh-beta-runtime-isolation.md`. Preview install and runtime use that same namespace: registry CONNECT is the only install egress, and only a root setup shell may raise loopback before setpriv clears capabilities.
- Private bounded preflight and run artifacts are stored in R2 bucket `openfloor-preflight-logs`, bound as `PREFLIGHT_LOGS`.
- Cloudflare static assets are bound as `ASSETS`.
- Cloudflare Images is bound as `IMAGES` for vinext image optimization.
- Drizzle defines the schema and generates migrations; runtime data access uses prepared D1 SQL.
- TypeScript is strict enough that public contract changes should fail typecheck and tests.

### Important hosting topology

The marketing site (`opnflr.com`) and production application (`app.opnflr.com`) are sibling Cloudflare deployments, not a path-prefixed pair. The permanent `release` branch deploys an isolated named Wrangler environment at `dev.app.opnflr.com`; `main` deploys production. `BASE_PATH` is `""` in both application environments, and `wrangler.jsonc` claims each hostname through its target-specific custom-domain route. See [`docs/system-architecture.md`](docs/system-architecture.md#important-hosting-topology) and [`docs/release-process.md`](docs/release-process.md).

## Authentication and identity

### Current decision: Cloudflare Access

Production identity is Cloudflare Access, not application-owned “Sign in with ChatGPT.” GitHub (primary, since 2026-08-27) and One-time PIN are the intended Access identity providers; Google is removed from the application's IdP list. `ACCESS_CUSTOM_LOGIN_ENABLED` (`wrangler.jsonc`) gates the app-owned `/signin` page — flipping it to `"false"` is the rollback path if production sign-in breaks.

Application admission is a separate D1 gate. Production now runs with `EARLY_ACCESS_GATE_ENABLED=true` after the disabled-mode Sheet/WAF acceptance. Every authenticated product page, API, desktop bootstrap, invitation/onboarding path, and presence connection requires an active early-access grant. Existing users are migration-backfilled; new users are unadmitted. A shared passcode may grant but never clear an explicit revocation. The public `/early-access` routes stay outside Cloudflare Access and hand authentication through the existing protected `/auth/complete` entry. The Sheet is never authoritative. Rollback is the versioned flag set to `false`. See [`docs/early-access.md`](docs/early-access.md).

Production has one self-hosted Access application with exactly `app.opnflr.com/api/*` and `app.opnflr.com/auth/complete` as destinations. Real pages sit outside Access and verify the signed `CF_Authorization` cookie minted at `/auth/complete`; API paths normally verify Access's assertion header. The production Allow policy includes `Everyone`, with D1 early-access admission layered afterward. Development mirrors the destination topology but must use a developer/tester-only Access policy because its D1 admission gate starts off. See [`docs/cloudflare-access-config.md`](docs/cloudflare-access-config.md) for the app-owned `/signin` mechanism, App Launcher/Cookie Path settings, JWT validation, and `/signout`. Read it before changing Access configuration.

### Legacy schema naming

The `users.chatgpt_user_id` column and `idx_users_chatgpt_user_id` index retain names from the earlier ChatGPT-identity design. In current code this column stores the generic stable `providerUserId`, currently the prefixed Cloudflare Access subject.

`agent_runs.codex_thread_id` is the same pattern: it stores whichever provider's thread/session id a run used and is exposed in TypeScript as `providerThreadId`. Never rename the SQL column — `agent_runs` has four inbound `ON DELETE CASCADE` foreign keys plus a set-null, and a drizzle rename emits a table recreate that cascade-deletes children (the `users` invariant's failure mode exactly).

Do not build logic that assumes the column contains a ChatGPT ID. Do not rename it casually: a rename requires a generated D1 migration, updated queries, integration tests, and a deployment plan.

### Trusted-header boundary

`worker/index.ts` verifies external identity and calls `requestWithTrustedIdentity`. That helper always deletes any client-provided internal trusted headers before adding verified values. Application code reads only those internal headers through `app/access-auth.ts`.

The WebSocket path does not rely on the application handoff. `handlePresenceRequest` authenticates at the Worker, resolves the internal user through D1 membership, and sends only trusted internal identity headers to the Durable Object.

### Local development and tests

- Local identity works only for loopback hosts (`localhost` or `127.0.0.1`) using `OPENFLOOR_DEV_USER_ID`, `OPENFLOOR_DEV_USER_EMAIL`, and `OPENFLOOR_DEV_USER_NAME`.
- Authenticated production routes reject requests without a valid Access identity; the `/` landing page remains public by design.
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

See [`docs/schema-invariants.md`](docs/schema-invariants.md) for the full per-table invariant reference (`users`, `sessions`, `session_members`, `session_invites`, `usage_months`, the Stripe tables, `session_mcp_servers`, `session_skills`, `user_provider_credentials`, the GitHub installation/connection tables, `repository_candidates` and its file/check tables, `github_webhook_deliveries`, `repository_check_commands`, the preflight tables, `agent_runs` and related tables, the rollback tables, the merge-conflict tables, `floor_agents`, `floor_assignments`, `floor_messages`, `session_files`, and `floor_queue_items`/`floor_queue_prompts`). Read the entry for any table before changing its schema, queries, or invariants.

### Snapshot contract

`FloorSnapshot` in `lib/floor-types.ts` is the public authoritative floor response:

- `revision`
- `autoDispatch`
- `autoResolveConflicts`
- `autoInjectFeedback`
- `agents`
- `assignments`
- `messages`
- `queue`
- `repository`
- `activeCandidate`
- `latestPreflight`
- `preview`
- `runs`
- `review`

`FloorSnapshot` includes `autoDispatch`, `autoProvisionAgents`, configured/effective generated-agent provider state, `autoResolveConflicts`, nullable `repository`, `activeCandidate`, bounded `latestPreflight`, nullable `preview`, active agents, and the latest 20 caller-visible runs. Preview is `null` while stopped or while `REPOSITORY_PREVIEW_ENABLED=false`; enabled snapshots expose provisioning, ready, failed, or derived expired state. Every queue item independently derives its caller-specific integrated-run rollback descriptor, so Queue rollback state is complete even when the run is older than that 20-run window. Runs derive `purpose` (`task` or `conflict_resolution`), nullable `conflictCaseId`, and their latest bounded rollback state. Large logs and artifacts are fetched separately. `review` is null until real repository/run data exists, then includes typed conflict cases/questions and candidate-wide attribution from dedicated queries rather than the latest-run window; never populate it from UI fixtures.

Run summaries, checks, and files are hydrated with one bounded run read plus at most one set-based checks read and one set-based files read. Never restore per-run query fan-out: the latest-20 floor list and unbounded candidate-wide Review history sit on the realtime refetch path. Dismissed queue items and their prompts are excluded from that snapshot path while their run audit history remains durable.

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

All paths below are root-relative in production and development; there is no production `/app` prefix.

See [`docs/api-contracts.md`](docs/api-contracts.md) for the full method/path/authorization/behavior table.

Response conventions:

- `401` means no authenticated identity.
- `400` means invalid input or a cross-session/invalid target.
- `404` conceals nonexistent sessions, non-membership, unauthorized owner-only resources, invalid invites, and revoked invites.
- `409` represents conflicts such as duplicate normalized agent name, stale queue order, stale conflict answers, owner leave, or any mutation on an ended session ("This session has ended."). `DELETE /api/account` returns `409 { code: "sessions_blocked", sessions }` when an owned session has live repository state (same class of conflict as `DELETE /api/sessions/[id]`'s `repository_state`/`integration_in_progress`), and writes nothing in that case.
- `403` with `{ code: "quota_exhausted" }` marks the session owner's monthly session-hours quota as spent — see "Plan limits and metering" below. `acceptInvite`'s seat-cap refusal returns `403` too, but without a machine-readable `code` today.
- Floor mutations return `{ floor }`; clients treat it as authoritative.

### Validation limits

Keep server validation in `lib/validation.ts` and cover it with unit tests. See [`docs/api-contracts.md`](docs/api-contracts.md#validation-limits) for the exact bound on every field (names, tokens, prompts, queue lists, conflict input, repository/candidate fields, provider credentials, skills, MCP servers).

## Plan limits and metering

Seats are sold but not assigned. The product enforces two limits per session owner's *effective* plan (`lib/plans.ts`'s `effectivePlan(plan, planStatus)` — `planStatus !== "active"` always resolves to `free`, so a lapsed or never-purchased plan never grants its stored tier's limits):

| Plan | Seats / session | Session hours / month |
| --- | --- | --- |
| free (explicit direct selection, signed-invite default, or lapsed paid plan) | 3 | 2 |
| pro ($30 USD/seat/month) | purchased quantity, 3–5 | 30 |
| max ($50 USD/seat/month) | purchased quantity, 3–10 | 100 |
| enterprise | unlimited | unlimited |

`lib/plans.ts` owns these exact catalog terms. Checkout and Portal changes retrieve the configured Stripe Price and require USD, the exact unit amount, monthly recurrence, and licensed usage before proceeding. Active or trialing Stripe state grants the mapped Pro/Max quantity; past-due, unpaid, paused, canceled, incomplete, unsupported-price, and invalid-quantity states never grant paid limits. Existing active manual Pro/Max grants with null `seat_limit` remain compatible at 5/10 seats; active Enterprise overrides self-serve Stripe.

Direct signups must explicitly select Free, Pro, or Max. Paid signup saves the profile but keeps `onboarded_at` null until Stripe reports an active/trialing subscription; Checkout return also performs an account-bound reconciliation so the buyer need not wait for webhook delivery. A user entering through a currently valid signed invite receives Free automatically and joins only after the existing explicit invite-acceptance action. A forged, revoked, or expired invite return path cannot bypass direct plan selection.

The free plan's 2h/month allowance is spent once per **email address**, not once per account row — `lib/plans.ts`'s `planHourLimit(plan, freeAllowanceUsed)` returns `0` in place of the free tier's 2h once `users.free_allowance_used_at` is set. Every hour-quota read site goes through `planHourLimit`. See the `users` entry in [`docs/schema-invariants.md`](docs/schema-invariants.md#users) for the full `prior_email_hash` mechanism.

See [`docs/plan-limits-metering.md`](docs/plan-limits-metering.md) for the full enforcement-point list (the four exact gates, and the never-gated wind-down set an owner past quota must always retain) and the `SessionPresence` metering mechanics (clock start, flush, idle timeout, close codes, and accepted imprecision).

### Stripe billing lifecycle

Stripe is authoritative for external subscription state; D1 is the authoritative product entitlement projection. `/home/settings`'s Plan & usage tab (`components/product/SettingsScreen.tsx`) is the single plan-management surface. Normal Portal cancellation is immediate; account deletion performs immediate Stripe cancellation with no refund before scrubbing D1. `STRIPE_CHECKOUT_ENABLED` stays false until all Stripe configuration, secrets, migrations, webhook delivery, and acceptance checks are ready. See [`docs/plan-limits-metering.md`](docs/plan-limits-metering.md#stripe-billing-lifecycle) for the full lifecycle detail, and `docs/stripe-billing.md` for the Portal configuration contract.

## Frontend architecture

### Server/client boundary

- Protected pages authenticate, upsert the user, authorize membership, and server-load initial data.
- Product screens under `components/product/` own page-level client behavior such as WebSocket connection, invite state, and routing.
- `SessionScreen` owns the lobby’s current repository/candidate presentation so `RepositoryCard` mutation results immediately update setup status and floor entry. `ProviderCredentials` is the shared write-only credential UI used by Settings, the lobby's `ModelConnectionCard`, and `HomeScreen`'s `CreateSessionDialog` AI-connection step.
- The Agent Floor receives the first `FloorSnapshot` from the server to avoid a loading-only shell.
- `usePersistentFloorData` is the asynchronous data-source boundary for floor reads and writes.
- A mutation response updates local state immediately; a newer remote floor revision triggers a refetch.

### Agent Floor structure

See [`docs/frontend-architecture.md`](docs/frontend-architecture.md) for the per-component breakdown (`Workspace.tsx`, `TopBar.tsx`, `ObjectiveBar.tsx`, `BriefRail.tsx`, `AgentFloor.tsx`/`AgentCard.tsx`, `PromptQueue.tsx`, `QueueOrderMenu.tsx`, `FloorDock.tsx`, `ReviewScreen.tsx`, `ConflictCenterDialog.tsx`, `ConflictResolver.tsx`, `Rail.tsx`).

### UI state that is intentionally local

The following currently reset on reload and must not be mistaken for shared data:

- Workspace versus Review selection.
- Selected agent and focus/all layout.
- Panel order, widths, collapse, and expansion.
- Queue scope, ordering mode, merge mode, and drag state.
- Queue section expand/collapse state (Live has no bar; Conflicted starts open, the other finished sections start closed).
- Selected chat thread and Team panel view.
- Teammate draft visibility mode.
- Browser conflict alerts (`openfloor:browserConflictAlerts`), which default off and remain per-device rather than session state.
- Menus, dialogs, transient notices, and form input before submission.

If product requirements call for any of these to persist or synchronize, add an explicit storage owner and document the decision.

The theme choice is deliberately a per-device preference: localStorage `openfloor:theme`, owned by `components/ThemeToggle.tsx`, never synchronized through D1 or presence. The guided tour's seen-it flags follow the same per-device convention (`components/GuidedTour.tsx`, ENG-17).

### Styling

`tokens.css` is the design-token source (System → Light → Stone → Dark → Charcoal themes). Every themed shell, including the public `.entry-shell`, must honor the pre-paint `html[data-theme]` choice; only an attribute-free System selection follows `prefers-color-scheme`. `components/session/SelectMenu.tsx` is the house dropdown — do not introduce native `<select>` elements. The `legacy-floor-*` filenames describe their origin in the preserved demo UI, not permission to restore demo behavior. See [`docs/frontend-architecture.md`](docs/frontend-architecture.md#guided-tour-and-styling-detail) for the full guided-tour mechanics and the theming/token-scoping detail (`.shop-shell` vs `.app-shell` vs `.entry-shell`, per-agent tone retuning).

### Preserved prototype

The complete pre-persistence demo is recoverable from branch `codex/demo-ui-snapshot` at commit `5958f34`. Use it only as a visual interaction reference. Never copy its mock data, canned timing behavior, fake agent output, or local-only collaboration model back into production.

## Repository map

See [`docs/repository-map.md`](docs/repository-map.md) for the full annotated directory tree.

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

Open the printed URL, normally `http://localhost:3000`, then use `/home`. Do not add `/app` in any environment.

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

See [`docs/testing-strategy.md`](docs/testing-strategy.md) for the full coverage lists for unit, D1 integration, Durable Object, rendering, and end-to-end tests. When adding a collaborative feature, prefer extending the two-context end-to-end flow over testing only one browser.

### Hydration and time formatting

Server-rendered text must be deterministic. Do not render `Date.now()`, `Math.random()`, browser-locale-only formatting, or server/client branches into shared initial markup. Use the helpers in `lib/date-format.ts` or pass an explicit server snapshot. The project previously encountered hydration mismatch from locale/date differences; tests should guard any new timestamp presentation.

Viewer-local timestamps are shown through `components/LocalDateTime.tsx`: it renders the deterministic UTC form on the server and on the first client render, then swaps to the host-timezone `formatShort*Local` variants after mount. Use it for any user-facing timestamp instead of calling the local formatters during render.

## Deployment environments and release flow

### Required bindings

Bindings (`wrangler.jsonc`): `DB`, `SESSION_PRESENCE`, `ASSETS`, `IMAGES`, `REPOSITORY_PREFLIGHT`, `AGENT_RUN_WORKFLOW`, `REPOSITORY_PREVIEW`, `SANDBOX`, `PREFLIGHT_LOGS`, `USER_AVATARS`. The top-level config is production; `env.development` repeats every non-inherited or stateful binding and points it at an isolated resource. Never share D1, R2, Workflow, Durable Object, GitHub App, Stripe, signing, or encryption authority between those environments.

Rollout gate flags: `EARLY_ACCESS_GATE_ENABLED`, `PREFLIGHT_ENABLED`, `REPOSITORY_PREVIEW_ENABLED`, `AGENT_RUN_ENABLED`, `STRIPE_CHECKOUT_ENABLED`, `CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, `GEMINI_RUN_ENABLED`, `GLM_RUN_ENABLED`, `QWEN_RUN_ENABLED`, `DEEPSEEK_RUN_ENABLED`. Early-access enforcement is enabled in production after its D1/Sheet/WAF acceptance; rollback is false without deleting grants or waitlist records. `AGENT_RUN_ENABLED` is enabled in production for admitted beta testers and in the developer-restricted development environment after the successful Sandbox identity deployment and adversarial CI proof. Development has no shared provider fallback keys by default, so testers connect their own credentials. OpenAI, Claude, Kimi, and Gemini are available; GLM, Qwen, and DeepSeek remain disabled until their own live-key acceptance passes. `PREFLIGHT_ENABLED` remains false because required check commands were removed this release. `REPOSITORY_PREVIEW_ENABLED` remains false in both environments; enabling it later requires wildcard preview DNS/TLS, an environment-specific preview Access application, that application's audience appended to the same environment's `CF_ACCESS_AUD`, migration deployment, and the development acceptance runbook. Production uses `preview.opnflr.com`; development uses `preview.dev.opnflr.com`. Durable Object migration `v1` registers `SessionPresence`; `v2` registers `Sandbox`.

The complete provider CLI, native file tools, child commands, and post-agent Git run as `openfloor-workspace` (uid 10002, gid 10001) in a mandatory bubblewrap mount/PID/network namespace with no capabilities and `no_new_privs`. Only installed execution dependencies, the repository, per-run scratch, read-only attachments, and a bound broker socket are mounted. A root broker outside that namespace holds run-scoped model/activity/context/conflict/MCP credentials and fixed upstream URLs; the inside loopback bridge at `127.0.0.1:45871` exposes placeholders and bounded, pinned routes. It never grants arbitrary external network access. Preview install reuses that bridge for CONNECT to `registry.npmjs.org:443` only. The separate publisher retains final verification and GitHub authority. Every post-agent Git operation remains inside the credential-free namespace; trusted bundle upload runs only afterward through a bounded regular-file reader that rejects links and special files. Transcript restore allows bounded regular files under provider transcript directories only. Cancellation forwards to the namespace supervisor, permits bounded transcript flushing, then kills remaining descendants before trusted artifact reads. Image generation is executor `v12`, publisher `v4`; the old setuid/shell-preload architecture is removed. Preserve this whole-process boundary and its exact-image adversarial tests when changing any runner.

See [`docs/deployment-config.md`](docs/deployment-config.md) for what each binding is for and the full explanation of every rollout gate (what stays true while it's off, what must be live before flipping it, and the rollback behavior).

### Required secrets

`INVITE_SIGNING_SECRET`, `EARLY_ACCESS_PASSWORD`, `WAITLIST_SHEET_WEBHOOK_URL`, `WAITLIST_SHEET_WEBHOOK_SECRET`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_STATE_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID` (optional), `GITHUB_CLIENT_SECRET` (optional), `RUNTIME_GATEWAY_SECRET`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_MAX_PRICE_ID`, `STRIPE_PORTAL_CONFIGURATION_ID`, `CREDENTIAL_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY` (optional), `MOONSHOT_API_KEY` (optional), `GEMINI_API_KEY` (optional), `ZAI_API_KEY` (optional), `DASHSCOPE_API_KEY` (optional), `DEEPSEEK_API_KEY` (optional).

Set a secret by its variable name, then enter the value when prompted:

```bash
npx wrangler secret put INVITE_SIGNING_SECRET
```

Do not pass the secret value as the `wrangler secret put` name. Never commit `.dev.vars`, Access credentials, signing secrets, tokens, or generated invite URLs. See [`docs/deployment-config.md`](docs/deployment-config.md) for what each secret is for.

### Deployment order

Normal feature/fix branches target the permanent `release` branch. A push to `release` runs the complete gate and deploys the named `development` environment at `dev.app.opnflr.com`. A reviewed `release` → `main` merge is production authorization and deploys `app.opnflr.com`. Only `hotfix/*` branches created from `main` may target `main` directly, and their merge must be synchronized back into `release`. Git tags are immutable SemVer markers created only after a production deployment succeeds. See [`docs/release-process.md`](docs/release-process.md) for the branch, protection, external setup, versioning, and rollback runbook.

Manual development order:

```bash
npm audit --omit=dev
npm test
npx wrangler d1 migrations apply DB --env development --remote
npm run build:development
npm run verify:deploy-artifact -- development
npx wrangler deploy --config dist/server/wrangler.json
```

Manual production order:

```bash
npm audit --omit=dev
npm test
npx wrangler d1 migrations apply DB --remote
npm run build
npm run verify:deploy-artifact -- production
npx wrangler deploy --config dist/server/wrangler.json
```

The dependency audit and complete test pipeline must pass before either environment mutates. Migrations must land before code that requires them. The build generates `dist/server/wrangler.json`; deployment uses that built config. `npm run test:e2e` builds the app with `tests/e2e/wrangler.jsonc` into that same `dist/`, producing a test-only config, so the target-specific artifact verifier must run between the final build and deployment. It rejects test variables and pins the target Worker name, custom domain, exact D1 ID, both private R2 bindings, both Workflow bindings, runtime origin, and reviewed rollout flags. Development pins agent execution on after its isolated setup acceptance while keeping Stripe Checkout and D1 early-access admission off.

Pull requests run the audit and the complete `npm test`-equivalent pipeline as sibling jobs in `.github/workflows/deploy.yml`, so a newly published production advisory cannot hide whether the suite passed. After the render suite's production build, the test job verifies production, builds and verifies development, then lets E2E replace `dist/`. Pushes to `release` and `main` require both jobs, then run separate target-specific migration/build/verify/deploy jobs through GitHub `development` and `production` environments. CI installs the lockfile-selected Playwright Chromium build before the suite. Playwright actions use a 15s `actionTimeout` so a missing-element click fails at the action instead of hanging until the test budget. The E2E harness uses the Cloudflare Vite plugin's direct Miniflare preview path, avoiding Wrangler 4.127.1's Linux dev-proxy crash without retries or vulnerable tool downgrades. Third-party actions and npm are exact-version pinned, checkout never persists credentials, and Cloudflare credentials are step-scoped to migration and deployment; dependency installation, audits, tests, and builds never receive them. Superseded pull-request runs may cancel, but neither in-flight branch deployment does. The manual sequences remain for emergencies and for external state Actions cannot create safely.

### Smoke test after deployment

Run the relevant flow first against development after every `release` deployment and repeat it against production after promotion.

1. Open public `https://app.opnflr.com` without an Access session.
2. Open `/signin` and verify both **Continue with GitHub** and **Email me a code** are visible; the missing email action means One-time PIN is not enabled on the target Access application and must be fixed before inviting testers. Complete one sign-in flow and verify return to `/home`.
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

- Josh beta SEC-01 closes the native file-tool and post-agent Git boundary gaps with whole-provider isolation and separate artifact upload. See [`docs/josh-beta-runtime-isolation.md`](docs/josh-beta-runtime-isolation.md) for limits, tests, and provider acceptance.

- Never trust forwarded identity headers directly from the public request.
- Never expose invite signing secrets or Access tokens to the client.
- Never log live prompt drafts or store them in analytics by default.
- Remember that team messages are visible to the room, while DMs are filtered per caller.
- Treat live drafts as sensitive room content visible to authenticated members.
- Preserve invalid-invite and non-member metadata concealment.
- Preserve the Worker-wide unsafe-`/api/*` browser mutation guard and response security headers. Headerless requests remain supported for trusted non-browser clients; cross-site Fetch Metadata or a mismatched `Origin` must fail before application routing.
- Remote MCP endpoints are untrusted egress. Require HTTPS on port 443, reject URL credentials and local/internal/non-global literal addresses at write time, and revalidate stored rows at dispatch. DNS rebinding and hostile public MCP responses remain residual risks.
- Never execute repository-controlled commands or post-agent Git as root or any token-bearing identity. Use the mandatory execution namespace; never mount broker, verifier, publisher, host process state, or credentials into it.
- Enqueue internal-ID-derived R2 prefixes before deleting sessions or scrubbing accounts. The scheduled cleaner must keep session-scoped jobs until the source session is gone, defer live-source rows so the 25-job window cannot starve later work, retry failures, paginate, and require the 24-hour delayed-write hold plus a final empty confirmation before removing an intent. Retention purges at most 25 sessions per scheduled invocation.

### Git and change hygiene

- Preserve unrelated worktree changes.
- Do not commit `.dev.vars`, build output, Wrangler state, Playwright artifacts, or `tsconfig.tsbuildinfo`.
- Do not modify the preserved demo snapshot branch as part of normal feature work.
- Keep migrations, schema, tests, docs, and code in the same logical change.
- Do not push, deploy, rotate secrets, or mutate production unless the task explicitly authorizes it.

## Known limitations and footguns

See [`docs/known-limitations.md`](docs/known-limitations.md) for the full list — provider-identity naming, `BASE_PATH`, Access configuration being external dashboard state, the Sandbox pinning, preflight/R2 bounds, GitHub App key formats, floor-snapshot DM filtering, `floor.changed` semantics, draft Hidden mode, mention parsing, ownership transfer, Review's data provenance, browser conflict alerts, and more. Read it before assuming a control, path, or behavior works the way it looks like it should.

## Roadmap guidance

Repository execution Phases 1–7 and automatic merge-conflict resolution are implemented. Future milestones should focus on deployment integrations, resolving the separately tracked manual-discard issue without weakening its lease, and broader agent lifecycle/product work rather than expanding GitHub permissions casually.

An owner cannot remove a member from a session today — `leaveSession` is self-service only and refuses owners. At a 3-seat free tier, one mis-sent invite permanently consumes a third of a session's capacity with no in-product remedy. An owner-initiated remove-member action is the next plan-limits-adjacent piece of work; it needs its own decision about notifying the removed member (`disconnectPresenceUser` and WebSocket close code `4001` already exist and would cover it).

## Decision log

Durable decisions live in [`docs/decision-log.md`](docs/decision-log.md), append-only. Read the entries relevant to the area you're touching (grep by section, date, or keyword) — don't read the whole log for an unrelated change; read it in full only when the change is broad enough to plausibly touch many prior decisions. Entries superseded in their entirety are archived in [`docs/decision-log-archive.md`](docs/decision-log-archive.md).

Append new decisions to `docs/decision-log.md` using the format at the top of that file. If a decision supersedes an older one only in part, mark that within the still-current entry; if it supersedes an older entry in full, add `**Status:** Superseded by "..." (date); retained for history.` to the old entry and move it to the archive in the same change.

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
- Agent runtime image changes pass the adversarial separate-uid container gate in CI.
- `npm test` passes.
- `README.md`, `docs/agent-backend-gaps.md`, and this file are updated where relevant.
- New durable decisions are appended to [`docs/decision-log.md`](docs/decision-log.md).
- No secrets, local environment files, build output, or test artifacts are included.
- Deployment and production mutation occur only with explicit authorization. Merging to `main` is that authorization: it triggers the automatic production deploy. Agents still never run manual deploys or mutate production state directly without being asked.

### Josh beta integration corrections (2026-09-04)

Settings offers **Refresh repository access** through the existing transient GitHub device proof. GitHub Configure callbacks without signed state are navigation-only and return to verification; they never grant access from a supplied installation ID. Verified installation scopes refresh atomically, including empty scopes, while associations for other linked GitHub accounts and existing session connections remain intact. Incomplete GitHub pagination or scope failures preserve existing grants and report a retryable error. Live installation repository lists remain intersected with the member's verified scope.

Onboarding and Settings use the same provider rollout gates as agent creation. Saved credentials for disabled providers remain visible as unavailable and removable; new connections to disabled providers are refused server-side.

Trusted publisher Git commands all carry transient HTTPS authentication because a partial clone may fetch promised blobs during bundle import or tree reads. Credentials are never persisted in Git configuration and retained errors redact both token and Basic encoding. Publication and integration commit descriptions use the sanitized opening user request plus an `Openfloor-Run` trailer; prompt bodies and credential-bearing openings are excluded. Publisher image generation is `v3`, executor pool generation `v10` for this image change.

### Josh beta run lifecycle and history (2026-09-04)

Migration `0046` adds nullable `agent_runs.completion` without recreating the table. Successful writable tasks with no changed files finish as `ready` plus `no_changes`, retain their output and task kind, complete the queue item, and release capacity without a branch or publication. Compare-and-set completion preserves cancellation and terminal outcomes. Conflict resolvers still require changes. Other successful tasks continue through publication and integration.

`GET /api/sessions/[id]/runs?before=<runId>` is member-only, no-store run history in pages of 20 ordered by `(created_at, id)` descending; cursors are session-bound. It includes retained inactive/deleted-agent runs, with checks/files hydrated in two set-based reads. The floor snapshot still contains only the latest 20 runs. Run history is read-only and retains final responses, summaries, diffs, activity and raw logs. Internal session briefs remain injected and stored but have no normal agent-card/history expander.

Persistent agent creation asks for Name and Task, using `Engineer` only for legacy API compatibility. That default role does not make a specialist a routing generalist: automatic tasks require keyword suitability or a legacy explicit Generalist role before persistent preference is applied. Otherwise the router provisions an eligible worker or holds the prompt for manual assignment. Existing model/billing/ownership permissions remain intact. Idle agents show Idle with inactive Pause/Stop controls; failed queue attempts say Retry. Publishing/integration indicators reflect real run status. Queue history only offers Open agent for an active exact agent ID; stale selection never falls back to another agent.

Session creation uses the server-loaded quota summary to show a Plan & usage dialog before collecting setup inputs when the allowance is already exhausted. The API remains authoritative; a later submission refusal keeps entered data and focuses/scrolls its error into view.

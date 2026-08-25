# openfloor Engineering Guide

This file is the authoritative repository-level guide for engineers and coding agents working on openfloor. It applies to the entire repository unless a more specific `AGENTS.md` is added in a subdirectory.

Last verified against `main`: 2026-08-21.

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

1. **D1-authoritative application state**: users, Stripe entitlement projections, sessions, memberships, invites, objective, agents, assignments, messages, queue items, queue prompts, ordering, and floor revision. Stripe remains authoritative for the external subscription lifecycle; D1 owns the product-facing projection.
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
- Explicit first-login Free/Pro/Max selection for direct signups; valid signed-invite signups receive Free automatically, while Enterprise remains sales-managed.
- Stripe Checkout for monthly Pro/Max subscriptions, exact purchased seat quantities, Customer Portal management and prorated plan changes, signed replay-safe entitlement webhooks, and immediate no-refund cancellation during account deletion.
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
- A unified session brief injected as every dispatched agent's prompt (`db/session-context.ts` + `lib/session-context.ts`, assembled at workflow dispatch): the agent's own request and prior attempts, every other agent and human assignment on the floor, already-integrated run summaries and files, other runs currently in flight with their live file edits, the rest of the queue, blocked/failed runs, and the last 30 public team-chat messages. The read is session-scoped with no `userId` parameter, so direct messages are structurally excluded rather than filtered — the query itself only ever selects `recipient_user_id IS NULL`. The brief is a snapshot at dispatch time, bounded to 24,000 characters with honest empty-section text and explicit truncation counts; it never fabricates floor state.
- A live re-read of that same brief for long runs: the Sandbox exposes a read-only `openfloor_session_context` MCP tool (`scripts/openfloor-mcp.mjs`, wired into the Codex SDK's `config.mcp_servers`) backed by `GET /runtime/run/context`. Tool calls surface in the activity timeline as a `tool_call` event. Pooled run sandboxes are keyed by `RUN_SANDBOX_IMAGE_VERSION` (`worker/agent-run-workflow.ts`) so a stale pooled container from before an image change is never claimed by a live run.
- The exact prompt a run received is persisted as an `agent_run_artifacts` row of kind `prompt` and visible to members through a second Agent-card expander, alongside the existing raw-log expander (whose own default output is unchanged).
- An owner-only nudge when public team chat has moved past the objective: `sessions.objective_updated_at` (distinct from `updated_at`, which every floor mutation touches) tracks only objective saves; once `OBJECTIVE_NUDGE_THRESHOLD` public messages postdate it, `ObjectiveBar` shows a banner that opens the existing inline editor. No new mutation; purely derived from data already in `FloorSnapshot`.
- Durable run, event, check, changed-file, and artifact metadata; bounded complete logs and diffs live in private R2.
- Real run status and file/check data in Agent cards and Review. Each passing run is automatically preserved on its own verified `openfloor/<session-short>/run/<run-short>` GitHub branch; consecutive prompts retain separate branches and audit history.
- Trusted incremental Git-bundle validation and non-force publication from a clean publisher Sandbox, followed by GitHub SHA reconciliation.
- Owner-only safe discard using an expected-SHA lease; externally modified run branches are never deleted.
- Serialized candidate integration inside `AgentRunWorkflow`, with a D1 candidate lease, authoritative GitHub ref reconciliation, non-force merge, one draft PR, queue completion, conflict preservation, and owner-only retry as a new run attempt.
- GitHub-authoritative final review snapshots with bounded PR files, check runs, commit statuses, head/base SHAs, draft state, mergeability, and merge-requirement state.
- Owner-only **Ready for review** and expected-head **Squash merge** actions. GitHub protection and review requirements are never bypassed.
- Verified post-merge cleanup of matching server-generated run/candidate refs using Git leases; mismatched refs are preserved and recorded as partial cleanup.
- Merged candidate audit history remains durable, while the next owner-started run creates a fresh candidate cycle from the latest base SHA.
- Per-user provider credentials (`user_provider_credentials`, providers `anthropic`/`openai`/`kimi`/`gemini`), now keyed `(user_id, provider, kind)` with two first-class kinds: `api_key` (validated against the provider's models endpoint on connect — `lib/provider-validation.ts` holds the per-provider URL + auth-header record) and `oauth` (a pasted subscription credential — Claude `setup-token` or ChatGPT `auth.json` — stored with `validated_at = null`, "Connected — not yet verified", because no free probe exists; never a faked timestamp). `credentialKindsForProvider` limits `oauth` to `anthropic`/`openai`, enforced at the PUT route and again at gateway resolution. All rows are AES-256-GCM-encrypted at rest under `CREDENTIAL_ENCRYPTION_KEY` (AAD: bare legacy `<userId>:<provider>` for `api_key`, `<userId>:<provider>:<kind>` for newer kinds — existing rows never need reconnecting) and write-only from the client (routes return only a last-four fingerprint — the token's for keys and setup tokens, the ChatGPT `account_id`'s for bundles). Per run, every runtime gateway resolves through the one shared ladder (`resolveRunProviderSecret`, `db/provider-credentials.ts`): the **agent owner's** connected credential of the kind the agent names (`floor_agents.credential_kind`; null = api_key else the single existing row), else the server key (always `api_key` by construction — openfloor never operates a subscription seat as a fallback), else refuses with a clear `503`. A present-but-unreadable owner credential, an agent-named kind the owner has not connected, and a hand-written row of a kind the provider does not allow all refuse rather than silently switching payer. Note: gateway upstream auth is still the api-key form for every kind — sending an `oauth` credential in its native header shape is the pending §4 work, so a connected subscription fails honestly at the vendor until that lands.
- Session-configured remote MCP servers (`session_mcp_servers`, v1 `http`/`sse` only, `stdio` deferred): the owner adds up to 10 per session in the lobby (name, transport, https URL, optional headers, enabled flag); members read summaries. Header values follow the credential at-rest rules — encrypted, write-only, reads expose header names only. `openfloor` is a reserved name, and the built-in `openfloor_session_context` server is always present and not user-removable. Enabled servers reach Claude runs in the SDK's `mcpServers` shape with their tools allow-listed per server (`mcp__<name>`), never via a blanket permission mode. Connections go directly from the run container to the configured host.
- Session-scoped imported Claude skills (`session_skills`): the owner pastes a validated `SKILL.md` in the session lobby (members read the list), bounded to 32,000 characters and 20 per session, with the name constrained to a filesystem-safe slug. Claude runs materialize them into the container user's `~/.claude/skills/` (never the git worktree) and enable exactly the imported names via the SDK's `skills` option; a skill's `allowed-tools` frontmatter cannot widen the run's toolset. The target repository's own `CLAUDE.md` is appended to the run prompt as bounded text (first 8,000 bytes) rather than loaded as a settings source. claude.ai skill sync is not implemented.
- A Claude agent runner (`scripts/claude-runner.mjs`, Claude Agent SDK, default model `claude-opus-5`) structurally parallel to the Codex runner, gated behind `CLAUDE_RUN_ENABLED` (currently on). `floor_agents.provider` (default `openai`) and nullable `model` choose the runner per run; `AgentRunWorkflow` branches at dispatch on `usesClaudeRunner(provider)` (`lib/provider-credentials.ts`). Claude runs execute as the non-root `openfloor-agent` user under the SDK's kernel sandbox (bubblewrap + proxy-enforced domain allowlist), with the pinned posture in `lib/claude-sandbox-settings.ts` and model traffic through `POST /runtime/anthropic/*` — see the 2026-08-21 Claude-runner decision-log entry for the verified isolation semantics.
- A Kimi (Moonshot) provider that reuses `scripts/claude-runner.mjs` unchanged — Moonshot's documented Anthropic-compat endpoint means only the gateway differs. Gated by `KIMI_RUN_ENABLED` (currently on); default model `kimi-k3`; model traffic through `POST /runtime/kimi/*` (`lib/anthropic-compat-gateway.ts`, the shared handler the anthropic route also uses; upstream `https://api.moonshot.ai/anthropic/v1`, Bearer auth per Spike A). Runner features (skills, MCP servers, sandbox posture, per-run HOME, non-root user) are inherited because they are runner properties, not model properties — see the 2026-08-24 Kimi decision-log entry.
- A Gemini agent runner (`scripts/gemini-runner.mjs`, spawning the pinned `@google/gemini-cli@0.56.0` in headless stream-json mode) gated by `GEMINI_RUN_ENABLED` (currently on); default model `gemini-3.5-flash`. Gemini runs execute as `openfloor-agent` with the ENTIRE runner srt-wrapped (`@anthropic-ai/sandbox-runtime@0.0.73`, gateway host the only allowed domain — the CLI has no built-in sandbox, unlike the Agent SDK), the CLI's fetch made proxy-aware by `scripts/gemini-proxy-preload.mjs`, and the pinned CLI posture in a SYSTEM-scope settings file (`lib/gemini-settings.ts`) that beats the target repository's own `.gemini/settings.json` in the CLI's merge order. Model traffic through `POST /runtime/gemini/*` (path pattern + filtered `alt` query, run JWT in `x-goog-api-key`). No skills and no CLAUDE.md append — the CLI natively reads the repository's GEMINI.md. See the 2026-08-24 Gemini decision-log entry for the verified posture.

Known production follow-up: the owner discard action still reports failure in the disposable acceptance repository after its Git authentication correction. Preserve the expected-SHA lease and error separation; diagnose this independently rather than weakening deletion safety or folding it into Phase 6.

### Explicitly deferred

- Per-agent **model** selection. Provider selection is implemented (agent-creation dialog, offering every provider whose rollout flag is on — the field renders once more than one provider is enabled), but `floor_agents.model` has no UI or API input — every run uses its provider's spike-verified default in `DEFAULT_PROVIDER_MODELS` until model selection is deliberately added. Operators retain the hand-set-column escape hatch (`resolveRunModel` honors a non-null `model`).
- Agent-authored chat messages and generic artifact download UI beyond the per-run raw-log and session-brief expanders. (Live run activity streaming is now real: the sandbox runner posts normalized Codex events to `/runtime/run/events`, they persist in `agent_run_events`, and sessions receive them as `run.activity` presence events. An agent may also read live session state mid-run through the `openfloor_session_context` MCP tool — see `/runtime/run/context` in the API table — but it cannot write.)
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
| `/app/settings` | `/settings` | Protected | Account settings: profile (name, GitHub handle, picture), plan and usage, preferences (Do Not Disturb, theme), and account deletion. Reached from the account menu behind the avatar in the header. |
| `/app/onboarding` | `/onboarding` | Protected | First-login account setup (profile picture, name, GitHub handle); gates `/home`, `/join/*`, and `/session/*` until complete. |
| `/app/join/[token]` | `/join/[token]` | Protected | Valid invite preview followed by explicit acceptance. |
| `/app/session/[id]` | `/session/[id]` | Protected/member-only | Session lobby, roster, invite controls, leave, and floor entry. |
| `/app/session/[id]/floor` | `/session/[id]/floor` | Protected/member-only | Main collaborative Agent Floor. |
| `/app/api/...` | `/api/...` | Protected | Authenticated application interfaces. |
| `/app/api/sessions/[id]/presence` | `/api/sessions/[id]/presence` | Protected/member-only | WebSocket upgrade. |
| `/app/webhooks/github` | `/webhooks/github` | Public/signed | GitHub delivery boundary; verifies payload size and HMAC before acknowledging. |
| `/app/webhooks/stripe` | `/webhooks/stripe` | Public/signed | Stripe delivery boundary; caps the raw body, verifies Stripe's signature, and reconciles subscription entitlement. |

Important behavior:

- The landing page owns no password, OAuth callback, or application login session.
- Clicking Sign in navigates to a protected path; Cloudflare Access performs the login and returns the browser.
- `/signout` is the production sign-out endpoint (an application route, not Cloudflare's own `/cdn-cgi/access/logout` — see "Authentication and identity" for why).
- A join page reveals session title and owner only after authentication and only for a valid, active signed token.
- Opening a join URL does not change membership. The user must click Join.
- Invite acceptance is idempotent because the session membership key is unique.
- Non-members opening a session or floor get a 404-style not-found response rather than session details.
- A member who leaves is disconnected from the room's presence object.
- An owner receives a conflict response if they try to leave.
- An owner can end the session instead. Ending is final in v1 (no un-end), idempotent, revokes the active invite in the same batch, and leaves all data readable. Collaboration, repository, preflight, run, and review mutations on an ended session return `409` with "This session has ended." — never `404`, which clients treat as "kicked from the session". Run cancellation remains available so already-running work can be stopped. Presence sockets stay open on ended sessions by design.
- Repository details are visible to session members, but only the owner can connect, configure, disconnect, or reconnect.
- The GitHub installation callback is protected by Access, signed, expires after 30 minutes, is bound to the initiating owner and session, and can be consumed once.
- The GitHub and Stripe webhook paths must remain outside Cloudflare Access so their providers can deliver events; raw-body signature verification is each route's authentication boundary.

## System architecture

The request and synchronization flow is:

```text
Browser
  -> Cloudflare Access policy for protected production paths
  -> openfloor Worker
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

- The marketing site owns the apex `opnflr.com` deployment (a separate Cloudflare Pages project, repo `openfloor-ai/openfloor.ai`).
- The openfloor application is a sibling deployment on its own subdomain, `app.opnflr.com`, claimed by a Workers custom domain — not a path nested under the marketing site.
- `next.config.ts` sets `basePath` to `components/basePath.ts`'s `BASE_PATH`, which is `""` in every environment now that the app owns its own origin.
- `components/basePath.ts` exists for literal public/API/WebSocket paths that the framework does not rewrite automatically; it's kept wired through (typed `: string` so truthiness checks on it don't narrow to `never`) so remounting under a path prefix again is a one-line change.
- Use Next `Link` with unprefixed application paths such as `/home` and `/session/...`; Next applies `BASE_PATH` automatically.
- Use `BASE_PATH` for manual `fetch`, `WebSocket`, and `public/` URLs.
- `wrangler.jsonc` claims `app.opnflr.com` via a `custom_domain: true` route, which has Cloudflare provision and own the DNS record. There is no longer a marketing-site path prefix to reserve or guard against collisions.
- Asset `not_found_handling` must remain `none` so asset requests that miss the static bundle can fall through to the Worker and be resolved through `ASSETS`.
- `.openai/hosting.json` and `build/sites-vite-plugin.ts` package Sites metadata and migrations during builds, but the current production runbook deploys the built Worker directly with Wrangler because Durable Object presence is a required capability. Do not switch the deployment path without proving D1, Durable Object, Access, asset, and route behavior end to end.

## Authentication and identity

### Current decision: Cloudflare Access

Production identity is Cloudflare Access, not application-owned “Sign in with ChatGPT.” Google and One-time PIN are the intended Access identity providers.

**Access is configured as an explicit allowlist, not protect-everything-then-bypass.** A path with no matching Access-application destination is never touched by Access at all — no challenge, no identity header, straight to the Worker. That, not a bypass rule, is what keeps the public landing (`app.opnflr.com/`), static assets, `/webhooks/*`, and `/runtime/*` public. This matters because Cloudflare has no "root only" destination syntax: an empty Path and a `*` Path are equivalent and both mean the hostname plus everything beneath it (confirmed against Cloudflare's own app-paths docs after this bit us once — a blank-path "bypass" destination for `/` briefly bypassed the *entire* domain instead). Do not try to reintroduce a protect-everything app with bypass carve-outs for the public paths; list only what must be protected.

Self-hosted applications cap at five destinations each, and there are six protected paths, so two applications share one policy (attached to the second via "Add existing policy", not duplicated):

- App 1 ("OpenFloor authenticated users"): `app.opnflr.com/home`, `app.opnflr.com/settings`, `app.opnflr.com/onboarding`, `app.opnflr.com/session/*`, `app.opnflr.com/join/*`
- App 2 (same policy): `app.opnflr.com/api/*`

**This list is enumerated per path across the two Access applications, not covered by a wildcard — it is dashboard state, external to this repo (`docs/cloudflare-access-branding.md`).** Adding any new protected page requires adding its path to whichever app has room (or a new app sharing the policy) in the Zero Trust dashboard in the same change; forgetting this step causes exactly the failure mode the (now-fixed) 2026-08-21 gap did — the page bounces every visitor back to sign-in because Cloudflare Access never attaches an identity header to it, `getAccessUser()` (`app/access-auth.ts`) sees nothing to trust, and `requireAccessUser`/`requireOnboardedUser` redirect to the landing interstitial regardless of whether the visitor is actually signed in elsewhere in the app.

**App 2's only destination is a wildcard path, so its App Launcher tile must stay hidden.** Cloudflare's App Launcher launches "the application's hostname" — the single domain configured on the app — so App 2's tile would otherwise be the literal, unroutable `app.opnflr.com/api/*`. A user re-entering through `openfloor.cloudflareaccess.com` after signing out has two openfloor tiles (Cloudflare gives a separate tile per app on one hostname) and a coin-flip chance of picking the broken one — this was the 2026-08-24 post-logout dead-end bug. Fix: App 2's **Experience settings → "Show application in App Launcher"** must stay off. Also confirm **Cookie Path Attribute** is off on both apps — enabling it forces re-authentication when moving between App 1's paths and App 2's, which the page/API split across one hostname would turn into constant re-auth churn.

Zero Trust → Settings → "Require Access Protection" must stay off. If enabled, an unmatched hostname/path is blocked (error 1050) instead of passed through, breaking the "unlisted = public" assumption this whole setup relies on.

The Worker validates the `cf-access-jwt-assertion` using:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD` — a comma-separated list, one tag per Access application (`lib/identity.ts`'s `parseAudienceList`). Two apps on one hostname means a page load and its first `/api` call can carry JWTs minted for two different AUD tags; whether a single `CF_Authorization` cookie's `aud` claim merges both apps' tags is undocumented by Cloudflare, so the Worker trusts either tag explicitly rather than depending on that.
- the team's JWKS at `/cdn-cgi/access/certs`
- issuer, audience, signature, and token expiry through `jose`

The provider user ID is stored as `cloudflare-access:<sub>`. Email and name are mutable display metadata, not identity keys.

**Sign-out is `/signout` (`app/signout/route.ts`), not Cloudflare's `/cdn-cgi/access/logout` directly.** Neither Cloudflare logout endpoint (app-domain or team-domain) accepts a `returnTo`, and the app-domain one only clears the app-domain cookie — the team-domain global Access session survives, so the next sign-in silently re-authenticates the same identity with no prompt. `/signout` clears the app-domain `CF_Authorization` cookie itself, then redirects to the team-domain logout to end the global session too; it must stay outside both Access applications' destinations so a signed-out user can still reach it. The user finishes on Cloudflare's hosted "logged out" page (brandable per `docs/cloudflare-access-branding.md`).

As defense in depth against the class of failure above (a wildcard-only Access app pointing a browser at a path nothing serves), `worker/index.ts` redirects a `404` to `/home` when the request is a `GET` under `/api/` carrying `sec-fetch-mode: navigate` — the Fetch Metadata header every modern browser attaches only to top-level document navigations, never to a `fetch()`/XHR call. An Accept-header fallback was tried and reverted: this codebase's own test helpers reuse `Accept: text/html` on real API calls, which made it redirect member-only `404`s that must stay `404`.

### Legacy schema naming

The `users.chatgpt_user_id` column and `idx_users_chatgpt_user_id` index retain names from the earlier ChatGPT-identity design. In current code this column stores the generic stable `providerUserId`, currently the prefixed Cloudflare Access subject.

`agent_runs.codex_thread_id` is the same pattern: it stores whichever provider's thread/session id a run used and is exposed in TypeScript as `providerThreadId`. Never rename the SQL column — `agent_runs` has four inbound `ON DELETE CASCADE` foreign keys plus a set-null, and a drizzle rename emits a table recreate that cascade-deletes children (the `users` invariant's failure mode exactly).

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
- Email updates on authentication (`upsertUser`). `display_name`, `first_name`, `last_name`, `github_handle`, and `avatar_key` are owned by onboarding and account settings, not the IdP — `upsertUser` never touches them.
- `first_name`/`last_name`/`github_handle`/`avatar_key` are set once by onboarding (`completeOnboarding`, `POST /api/account/onboarding`) and are editable afterward through account settings (`updateProfile`, `PATCH /api/account/profile`). `display_name` is always derived as `"First L."` (`lib/display-name.ts`'s `displayNameFrom`) by both writers, so it can never drift out of that format. Unlike onboarding's `COALESCE`-based avatar write (which can only add a picture, never remove one), `updateProfile`'s `avatarKey` is a genuine three-state argument — omitted keeps the existing key, `null` clears it — so account settings is the only place a picture can be removed.
- Creation and update timestamps are epoch milliseconds.
- `plan` (`pro`/`max`/`enterprise`, default `pro`), `plan_status` (`inactive`/`active`/`past_due`/`canceled`, default `inactive`), and nullable `seat_limit` decide entitlement — see "Plan limits and metering" below. `upsertUser` writes none of them. Stripe subscription reconciliation projects Pro/Max status and purchased quantity; active Enterprise remains a sales-managed override. A legacy/manual active Pro/Max row with null `seat_limit` keeps the historical 5/10-seat cap.
- `deleted_at` is a tombstone, not a soft-delete filter — no read path queries against it. Set only by `deleteAccount` (`DELETE /api/account`), it marks a row that account deletion scrubbed and released rather than one currently in use; see "Account deletion" below for the full contract.
- **`users` must never be recreated via a Drizzle table-swap migration once it holds real rows.** It has four inbound `ON DELETE CASCADE` foreign keys (`session_members.user_id`, `session_invites.created_by`, `github_connection_states.user_id`, `user_provider_credentials.user_id`); a `DROP TABLE users` cascade-deletes all four even inside the standard `PRAGMA foreign_keys=OFF` migration wrapper drizzle-kit generates for a table with a named CHECK constraint — confirmed by rehearsing the generated migration for `plan_status` against seeded local data during the plan-limits work (`drizzle/0019_redundant_may_parker.sql` was hand-fixed to a plain `ALTER TABLE ADD COLUMN` instead, the same technique `0018` already used for `plan` itself). `deleted_at` (`drizzle/0020_regular_cardiac.sql`) is a nullable, unconstrained column, so drizzle-kit generated a plain `ALTER TABLE ADD COLUMN` on its own — no hand-fix needed. Any future change to this table's CHECK-constrained columns still needs the same hand-fix, or a genuinely different migration strategy (backfill into a new table, dual-write, swap) — never a bare `db:generate` accept.

**Account deletion.** `deleteAccount` (`db/sessions.ts`) cannot issue a hard `DELETE FROM users`: roughly a dozen columns across `floor_messages`, `floor_agents`, `floor_queue_prompts`, `repository_candidates`, and other tables reference `users.id` with no cascade action, and the invariant above rules out adding one via a table recreate. `DELETE /api/account` first checks every repository blocker, immediately cancels all known non-terminal Stripe subscriptions without refund, then calls `deleteAccount`, which rechecks blockers before writing. A Stripe failure leaves the account intact. After successful cancellation, `deleteAccount` performs this D1 batch:

1. Pre-checks every session the user owns with the same guards `deleteSession` uses (`getBlockingIntegrationRunId`, live `repository_candidates`). Any blocked session refuses the *entire* deletion and nothing is written — the account and every session stay exactly as they were.
2. Hard-deletes every session the user owns (children cascade with the session, same as `deleteSession`).
3. Drops the user's membership and `floor_assignments` rows in sessions *other* people own (`session_members` would cascade on its own; `floor_assignments` has no FK action, the same reason `leaveSession` deletes it explicitly), and the user's `user_provider_credentials` rows — that table's cascade FK never fires because step 4 scrubs the users row instead of deleting it.
4. Scrubs and releases the identity: `chatgpt_user_id` and `email` are rewritten to values the IdP can never present again (`'deleted:' || id`, `'deleted+' || id || '@invalid'`), name/handle/avatar are cleared, `display_name` becomes `"Deleted user"`, `plan_status` becomes `canceled`, `seat_limit` becomes null, and `deleted_at` is stamped. `upsertUser`'s two identity lookups both add `AND deleted_at IS NULL`, so the next sign-in with the same Access identity creates a brand-new row rather than resurrecting the tombstone.

Deliberately left alone: `usage_months` rows survive (see that table's own no-FK note — "future account deletion" is this), and authored `floor_messages`/`floor_agents`/`floor_queue_prompts`/`repository_*` rows in sessions the user did not own survive too, now attributed to the scrubbed `"Deleted user"` display name — the tombstone row exists specifically to keep those foreign keys valid.

#### `sessions`

- UUID, title, nullable objective, timestamps.
- `updated_at` advances on every floor mutation (`bumpFloorRevision` touches it alongside `floor_revision`), so it cannot stand in for "the objective was last edited." `objective_updated_at` is the dedicated column, set only by `updateSessionObjective`; it drives the owner-only objective-nudge banner (`lib/floor-state.ts`'s `countMessagesSinceObjective`).
- `floor_revision` is a monotonically increasing integer for persisted floor reconciliation.
- Session creation also creates owner membership and an active invite in one D1 batch.
- Nullable `ended_at` is the lifecycle marker. Null means live; a timestamp means ended and read-only. Writes authorize through `getActiveMembershipRole` (throws `SessionEndedError` for members of ended sessions); reads keep using `getMembershipRole` so ended sessions stay viewable. `leaveSession`, `endSession`, `deleteSession`, and non-member concealment intentionally bypass the ended guard.
- Retention: the Worker's `scheduled()` handler (daily cron in `wrangler.jsonc`) runs `purgeExpiredSessions`, deleting repository-free sessions with `ended_at` older than `ENDED_SESSION_RETENTION_MS` (30 days), then broadcasts `members.changed` so connected tabs refetch. Never-ended sessions and sessions with any repository connection are never purged automatically. Manual deletion uses the same repository-state guard.
- `active_seconds` is a display-only running total of seconds this session had at least one connected participant, booked by the `SessionPresence` Durable Object (see "Plan limits and metering" below). It cascades away with the session, unlike the `usage_months` billing ledger.

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

#### `usage_months`

- Composite primary key `(owner_user_id, month)`, `month` a UTC `"YYYY-MM"` string (`lib/plans.ts`'s `currentMonth()`). One row per owner per calendar month; `seconds` accumulates presence time across every session that owner owns, live and ended alike.
- **Deliberately has no foreign keys.** The ledger must outlive both `purgeExpiredSessions` (a session's `active_seconds` cascades away with it; the owner's `usage_months` total must not) and, if it is ever added, account deletion. Do not add a `references()` here without re-deriving this from scratch.
- Written only by `SessionPresence.flushUsage` (`worker/presence.ts`), via `INSERT ... ON CONFLICT DO UPDATE SET seconds = seconds + excluded.seconds`. Never written from an HTTP route.

#### `stripe_customers`, `stripe_subscriptions`, and `stripe_webhook_events`

- `stripe_customers` binds one internal `users.id` to one unique Stripe customer ID. Email is display metadata sent to Stripe, never the purchase-to-account key.
- `stripe_subscriptions` stores bounded subscription snapshots: Stripe customer/subscription/price IDs, mapped Pro/Max plan, quantity, status, current-period end, cancel-at-period-end flag, and Stripe event creation time. The latest valid active or trialing snapshot projects `users.plan`, `plan_status = active`, and exact `seat_limit`; past-due/unpaid/paused projects `past_due`; terminal state projects `canceled`.
- `event_created` prevents an older subscription delivery from overwriting a newer snapshot. Subscription projection still reads every subscription for the user so one stale row cannot arbitrarily become authoritative.
- Unknown prices and invalid quantities are stored for audit but fail entitlement closed and make the webhook return `500` for retry. Active Enterprise is never downgraded by Stripe.
- `stripe_webhook_events` deduplicates Stripe event IDs and records processing/processed/failed state plus a bounded error. Failed events may be retried; processed replays are acknowledged without reapplying.
- These rows deliberately keep their foreign keys to the scrubbed user tombstone after account deletion. A terminal cancellation delivery after tombstoning is acknowledged; any non-terminal subscription against a deleted account remains an error because billing is still live.

#### `session_mcp_servers`

- Session-configured remote MCP servers for agent runs, unique per `(session_id, name)`; cascades away with the session. v1 is `http`/`sse` over HTTPS only — `stdio` and any openfloor-controlled egress proxy are deferred.
- `name` is a lowercase slug; `openfloor` is reserved (rejected at validation, stripped again at serialization and in the runner). Bounds (`lib/mcp-config.ts`): URL ≤ 2,048 characters, ≤ 16 headers (token names ≤ 128, values ≤ 2,048, no control characters), 10 servers per session.
- Header values may carry credentials, so they follow `user_provider_credentials`' at-rest contract: AES-256-GCM under `CREDENTIAL_ENCRYPTION_KEY` with AAD `mcp:<row id>`, write-only from the client — reads return the plaintext `header_names` list only. Updates treat omitted headers as "keep" and `null` as "clear" (the `updateProfile` avatar convention).
- Run dispatch decrypts enabled servers' headers in the workflow; an undecryptable row (e.g. after key rotation) fails the run with a clear message — never a server silently dropped or connected without auth.

#### `session_skills`

- Session-scoped imported Claude skills, unique per `(session_id, name)`; re-importing a name replaces it. Cascades away with the session.
- `name` comes from validated `SKILL.md` frontmatter (`lib/skill-validation.ts`) and is a lowercase slug by construction — path separators and traversal segments are unrepresentable, which is what makes the materialization path (`~/.claude/skills/<name>/SKILL.md` in the run container) safe. The workflow re-checks the slug before writing anyway.
- Content is bounded (32,000 characters), descriptions to 500, and a session holds at most 20 skills (`SkillLimitError` → `409`). Members read summaries (never content over the API); only the owner imports or removes; mutations refuse on ended sessions.
- Skills are enabled per run as an explicit SDK `skills` list. The runner always passes the option — an omitted `skills` means "CLI defaults", not "off" — and adds the `Skill` tool to its positive `tools` base set only when at least one skill exists.

#### `user_provider_credentials`

- Composite primary key `(user_id, provider, kind)` — widened from `(user_id, provider)` on 2026-08-24 so one user can hold an API key AND a subscription credential for the same provider. That widening was the one table recreate this table has had (SQLite cannot alter a primary key in place; migration `0025`, a drizzle `__new_` swap, safe because nothing references this table and the copy preserves `created_at`). `provider` (`anthropic`/`openai`/`kimi`/`gemini`) and `kind` (`api_key`/`oauth`) remain open enums — TS-typed with **no SQL CHECK** (the `agent_run_artifacts.kind` convention) so adding an enum *value* never requires a recreate; the earlier "never requires a table recreate" claim is corrected to enum values only.
- `ciphertext` is the AES-256-GCM encryption of the stored secret (`lib/credential-crypto.ts`): key derived by SHA-256 from the `CREDENTIAL_ENCRYPTION_KEY` Worker secret, fresh 96-bit IV per write, and `credentialAadContext` bound as AAD so a ciphertext copied to another row fails to decrypt — the bare legacy `"<userId>:<provider>"` for `api_key` rows (existing rows stay decryptable, nobody reconnects) and `"<userId>:<provider>:<kind>"` for newer kinds. Rotating the secret invalidates every stored credential; users reconnect.
- Write-only from the client: no endpoint returns a stored value. Reads return `fingerprint` (last four characters — of the token for `api_key`/setup tokens, of the ChatGPT `account_id` for auth bundles, never a refresh token), `kind`, and `validated_at` (set on connect after a successful provider models-endpoint check for `api_key`; null for `oauth`, which has no free probe — "Connected — not yet verified").
- `kind` is `api_key` or `oauth`. An `oauth` row stores a pasted subscription credential the user minted themselves (`claude setup-token` output, or a ChatGPT `auth.json` bundle) — a paste-a-credential flow, not an openfloor-operated OAuth login (which remains out of scope; see the §Out-of-scope note in the 2026-08-24 credential-kinds decision entry). `credentialKindsForProvider` allows `oauth` only for `anthropic`/`openai`, enforced at the PUT route and at gateway resolution. A server fallback credential is always `api_key` by construction — plain string bindings — and openfloor never operates one person's subscription seat for others.
- The `ON DELETE CASCADE` FK to `users` never fires in practice — `deleteAccount` scrubs the users row rather than deleting it, so it deletes these rows explicitly in the same batch.
- **AAD binds ciphertext to the user id, so account identity operations must preserve that id.** Every runtime path does: `upsertUser`'s cross-method email fallback and its `ON CONFLICT(email)` insert both re-key the *same surviving row* — the id never changes (pinned by a test in `tests/worker/credentials.test.ts`). The one historical row-collapse (migration `0022_account_email_merge`) predates this table in migration order, so no credential row can ever have existed for a merged-away account. Any *future* migration that collapses two `users` rows must explicitly migrate (decrypt-and-re-encrypt under the winner's id) or delete the losing row's credentials — silently orphaning undecryptable ciphertext is not acceptable.
- Owner credential resolution (`getRunAgentOwnerCredential`, wrapped by the shared `resolveRunProviderSecret` ladder every gateway calls) requires `removed_at IS NULL` on the membership row, following the member-removal convention; credentials themselves belong to the user, not a membership, so removal from a session never touches them. The join also narrows by the agent's `credential_kind`: a named kind matches only its own row, and the caller can distinguish "owner has nothing" (server fallback allowed) from "owner lacks the named kind" (refuse).

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
- Candidate refs are generated only by the server as `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>` and are created without force from the configured base ref. The owner supplies bounded display metadata, not an arbitrary ref; openfloor normalizes the name into a lowercase ASCII slug and retains the unique ID suffix.
- A newer base SHA marks the candidate behind; an unexpected candidate head marks the connection externally modified. Neither condition rewrites GitHub.
- The `status` column itself only ever holds `creating`, `active`, or `creation_failed`; there is no `merged` value in the D1 CHECK. `merged` is a derived read-layer state — `db/repositories.ts` reports it whenever `merged_at IS NOT NULL`, regardless of the stored `status`. Only creating/active rows (with `merged_at IS NULL`) participate in the one-live-candidate constraint, so merged history does not block the next cycle.
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
- `agent_run_artifacts.kind` is `codex_log`, `diff`, or `prompt` (UPSERT-keyed on `(run_id, kind)`; no SQL CHECK, TS-enum only). `prompt` is the exact session brief written to the agent's workspace, persisted so members can see what a run was actually told (`components/session/AgentCard.tsx`'s second expander). `GET /api/sessions/[id]/runs/[runId]/artifacts` defaults to concatenating only `codex_log` + `diff` (unchanged from before `prompt` existed); an explicit `?kind=` returns exactly one artifact with no heading.
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
- `provider` (`anthropic`/`openai`/`kimi`/`gemini`, TS-only open enum, default `openai`) selects the run runner; nullable `model` overrides the provider's default (`lib/provider-credentials.ts`) and has no UI yet. Nullable `credential_kind` (TS-only open enum, no default) says which of the owner's credential kinds pays for this agent's runs: null means "the owner's default" (api_key when connected, else the single existing row), so pre-existing agents bill exactly what they billed before; a named kind the owner lacks refuses the run with an actionable `503` — never the other kind, never the server key. The create dialog offers the choice (Billing field) only for providers with more than one kind and never reveals which kinds the chosen owner has actually connected. Creation offers only providers whose rollout flag is on (`CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, `GEMINI_RUN_ENABLED`; the dialog's provider field renders once more than one is enabled), and the API refuses a gated provider with `503` — a gated-provider agent cannot be *created*. Agents created while a flag was on persist through a flag rollback by design and degrade correctly: auto-dispatch skips their items, manual runs return `disabled`.
- No other runtime fields, branch, progress, files, or checks exist.

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
- Status is `queued`, `running`, `blocked`, `completed`, `paused`, `failed`, or `cancelled`. Only queued items can be merged or started.
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
| `POST /api/account/onboarding` | Authenticated user | `multipart/form-data` `{ firstName, lastName, githubHandle?, avatar?, plan?, quantity?, returnTo }`. A valid signed-invite return forces Free and completes onboarding. Direct Free completes onboarding; direct Pro/Max saves the profile without `onboarded_at` and returns a Stripe Checkout URL. Missing/invalid direct selection is `400`. |
| `PATCH /api/account/profile` | Authenticated user | `multipart/form-data` `{ firstName, lastName, githubHandle?, avatar?, removeAvatar? }`; account-settings profile edit. `avatar` and `removeAvatar` are mutually exclusive (`400` if both are sent); omitting both keeps the existing picture. Never touches `onboarded_at`. Returns `{ user }`. |
| `PATCH /api/account/settings` | Authenticated user | Update `{ doNotDisturb: boolean }`. |
| `GET /api/account/avatar/[userId]` | Authenticated user | Stream the target user's avatar from R2, or `404` if none is set; `cache-control: private, max-age=300`. |
| `DELETE /api/account` | Authenticated user | Body `{ confirm: "DELETE" }` (`400` otherwise). Checks repository blockers, cancels known Stripe subscriptions immediately without refund, rechecks blockers, then scrubs/releases the account. `409 { code: "sessions_blocked", sessions }` for repository state; `502` when Stripe cancellation fails and the account remains intact. |
| `POST /api/billing/checkout` | Onboarded authenticated user | Validate `{ plan: "pro" \| "max", quantity, returnTo? }`, bind Checkout to the internal user ID, and return `{ url }`. Refuses duplicate non-terminal subscriptions, active Enterprise, invalid quantities, mismatched configured prices, or a disabled rollout gate. |
| `POST /api/billing/change` | Authenticated user with Stripe subscription | Validate the requested Pro/Max plan and quantity, then return a Customer Portal confirmation deep-link for an immediate prorated update. |
| `POST /api/billing/portal` | Authenticated user | Return a Customer Portal URL for the account-bound Stripe customer. Portal configuration owns immediate cancellation and the allowed products/proration contract. |
| `GET /api/billing/checkout/return` | Authenticated Checkout owner | Retrieve the bounded Checkout session ID, verify its internal user binding and paid subscription, reconcile current Stripe state, then redirect to the safe app return path. |
| `GET /api/account/credentials` | Authenticated user | List the caller's provider-credential summaries (provider, kind, last-four fingerprint, validation time). Never returns a stored value. |
| `PUT /api/account/credentials/[provider]` | Authenticated user | Body: exactly one of `{ apiKey }` (kind `api_key`, ≤512-char opaque token, validated against the provider's models endpoint), `{ setupToken }` (kind `oauth`, same token rules, stored unvalidated), or `{ authJson }` (kind `oauth`, ≤8192-char JSON bundle shape-checked for `tokens.account_id`/`access_token`, stored unvalidated). Encrypts and upserts per `(provider, kind)`. `404` unknown provider, `400` invalid input, provider-rejected key, or a kind the provider does not accept, `502` provider unreachable. Returns `{ credential }` (summary only — write-only contract). |
| `DELETE /api/account/credentials/[provider]` | Authenticated user | Disconnect the caller's credential for that provider; `?kind=` picks the row (default `api_key` for back-compat; `404` for a kind the provider does not accept); `204`. |
| `POST /api/sessions` | Authenticated user | Create `{ title, objective? }`; creator becomes owner; returns session and active invite URL. `403 { code: "quota_exhausted" }` once the caller's monthly session hours are spent. |
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
| `POST /api/sessions/[id]/agents` | Session member | Create `{ name, role, task, ownerUserId, provider?, credentialKind? }` (provider defaults to `openai`; a rollout-gated provider returns `503`; `credentialKind` must be among `credentialKindsForProvider(provider)`, else `400`). |
| `PATCH /api/sessions/[id]/assignments/[memberId]` | Session member | Persist `{ task: string \| null }`. |
| `POST /api/sessions/[id]/messages` | Session member | Persist `{ text, recipientUserId? }`. |
| `POST /api/sessions/[id]/queue` | Session member | Persist `{ prompt, agentId? }`; null target is valid. |
| `PATCH /api/sessions/[id]/queue/order` | Session member | Persist an exact unique `{ itemIds }` order. |
| `POST /api/sessions/[id]/queue/merge` | Session member | Merge at least two existing same-target items, preserving prompts. |
| `GET /api/sessions/[id]/skills` | Session member | List imported Claude-skill summaries (name, description, size, updated); never content. |
| `POST /api/sessions/[id]/skills` | Owner | Import `{ content }` as a validated `SKILL.md`; upserts by frontmatter name. `400` malformed, `409` at the 20-skill cap or on an ended session. |
| `DELETE /api/sessions/[id]/skills/[skillId]` | Owner | Remove one imported skill; returns the updated list. |
| `GET /api/sessions/[id]/mcp-servers` | Session member | List configured MCP-server summaries (name, transport, url, header names, enabled); never header values. |
| `POST /api/sessions/[id]/mcp-servers` | Owner | Add `{ name, transport, url, headers?, enabled? }`. `400` invalid or reserved name, `409` duplicate name, at the 10-server cap, or on an ended session. |
| `PATCH /api/sessions/[id]/mcp-servers/[serverId]` | Owner | Update any of `{ transport, url, headers, enabled }`; omitted headers keep, `null` clears. |
| `DELETE /api/sessions/[id]/mcp-servers/[serverId]` | Owner | Remove one server; returns the updated list. |
| `GET /api/sessions/[id]/presence` with Upgrade | Session member | Authenticated WebSocket handoff to the per-session Durable Object. |
| `POST /api/sessions/[id]/repository/connect` | Owner | Create a short-lived signed GitHub installation state and return the installation URL. |
| `GET /api/github/callback` | Authenticated initiating owner | Consume the signed installation callback once and return to repository setup. |
| `GET /api/sessions/[id]/repository` | Session member | Return the durable repository connection and ordered required checks, or null. |
| `GET /api/sessions/[id]/repository/options` | Owner | List repositories and branches available to the pending or connected installation. |
| `POST /api/sessions/[id]/repository` | Owner with pending callback | Persist the selected repository, base branch, and required commands. |
| `PATCH /api/sessions/[id]/repository` | Owner | Change the base branch or required commands for the same connected repository. |
| `DELETE /api/sessions/[id]/repository` | Owner | Mark the connection disconnected without mutating GitHub. |
| `POST /api/sessions/[id]/repository/candidate` | Owner | Accept bounded `{ name, description }` metadata (defaulted by the UI and legacy empty-body callers from the session title/objective), verify the configured base SHA, and create one safely slugged server-owned candidate branch without force. |
| `POST /api/sessions/[id]/repository/sync` | Owner | Reconcile repository metadata and base/candidate heads without modifying GitHub. `403 { code: "quota_exhausted" }` at the owner's spent quota. |
| `GET /api/sessions/[id]/repository/preflight` | Session member | Return the latest bounded preflight/check state. |
| `POST /api/sessions/[id]/repository/preflight` | Owner | Start one durable preflight for the exact active candidate; requires at least one command. `403 { code: "quota_exhausted" }` at the owner's spent quota. |
| `GET /api/sessions/[id]/repository/preflight/[preflightId]/logs` | Session member | Stream the caller-authorized bounded command logs from private R2. |
| `GET /runtime/preflight/source` | Short-lived source JWT | Proxy the exact candidate archive without exposing a GitHub installation token to the Sandbox process. |
| `POST /api/sessions/[id]/queue/[queueItemId]/run` | Owner | Start a durable Codex run for an assigned queued item at the exact active candidate SHA. `403 { code: "quota_exhausted" }` at the owner's spent quota (also gates `worker/session-router.ts`'s auto-dispatch, the only other place a run starts). |
| `POST /api/sessions/[id]/runs/[runId]/cancel` | Owner | Request cancellation of an active run. |
| `POST /api/sessions/[id]/runs/[runId]/discard` | Owner | Delete only an unchanged, verified openfloor run branch using an expected-SHA lease; retain audit history. |
| `POST /api/sessions/[id]/runs/[runId]/retry` | Owner | Retry a conflicted queue item as a new run attempt pinned to the latest candidate SHA. `403 { code: "quota_exhausted" }` at the owner's spent quota. |
| `POST /api/sessions/[id]/review/ready` | Owner | Reconcile the exact active PR and use GitHub's ready-for-review mutation; preserve 404 concealment. |
| `POST /api/sessions/[id]/review/merge` | Owner | Reconcile head/base/files/checks/mergeability, request an exact-head squash merge, confirm it, and safely clean matching openfloor refs. |
| `GET /api/sessions/[id]/runs/[runId]/artifacts` | Session member | Return caller-authorized bounded run artifacts from private R2; unfiltered defaults to `codex_log` + `diff` (unchanged), `?kind=` returns exactly one artifact (e.g. `prompt`). |
| `GET /api/sessions/[id]/runs/[runId]/events` | Session member | Return one run's persisted activity timeline incrementally via `?after=<sequence>`. |
| `POST /runtime/run/events` | Short-lived run events JWT | Ingest bounded, runner-sequenced activity events for one active run and broadcast them as `run.activity`. |
| `GET /runtime/run/source` | Short-lived run source JWT | Proxy the exact candidate archive for one run. |
| `GET /runtime/run/context` | Short-lived run context JWT | Re-render the same session brief the run was dispatched with, from current D1 state; called by the `openfloor_session_context` MCP tool the sandbox exposes to Codex so a long run can re-read the floor mid-run. |
| `POST/GET /runtime/run/bundle` | Short-lived operation JWT | Store an agent-exported bounded Git bundle and serve it only to the clean trusted publisher. |
| `POST /runtime/openai/v1/responses` | Short-lived run OpenAI JWT | Forward one active run's Codex request, injecting the agent owner's connected OpenAI key when present, else the server credential, outside the repository process. `503` with a clear message when neither exists or the owner's key cannot be decrypted — never a silent fallback. |
| `POST /runtime/anthropic/v1/messages` (+ `/count_tokens`) | Short-lived run Anthropic JWT | Forward one Claude run's model request with the same owner-else-server-else-`503` resolution, translating the run JWT to upstream `x-api-key` auth (shared handler: `lib/anthropic-compat-gateway.ts`). Any other path is logged and concealed so the allowlist is finalized from observed traffic. |
| `POST /runtime/kimi/v1/messages` (+ `/count_tokens`) | Short-lived run Kimi JWT | Same shared Anthropic-compat handler against `https://api.moonshot.ai/anthropic/v1`, injecting the resolved Moonshot key as `authorization: Bearer` (Spike-A-verified). `count_tokens` stays allowlisted even though Moonshot 404s it — the CLI degrades on the vendor's answer, not on concealment. |
| `POST /runtime/gemini/v1beta/models/<model>:<verb>` | Short-lived run Gemini JWT (`x-goog-api-key`, Bearer fallback) | Standalone route (deliberately not the Anthropic-compat helper) against `https://generativelanguage.googleapis.com`: verbs `generateContent`/`streamGenerateContent`/`countTokens`, the query string forwarded filtered to `alt` (`?alt=sse` is how the CLI streams), the resolved Google key injected as `x-goog-api-key`. Any other path is logged and concealed. |
| `POST /webhooks/github` | Valid GitHub HMAC | Deduplicate and process bounded installation, access, repository, push, PR, check, and status deliveries. |
| `POST /webhooks/stripe` | Valid Stripe signature | Cap the raw body at 256 KB; deduplicate and reconcile supported Checkout, subscription, and invoice lifecycle deliveries into D1 entitlement. Invalid signature is `401`; reconciliation failure is `500` so Stripe retries. |

Response conventions:

- `401` means no authenticated identity.
- `400` means invalid input or a cross-session/invalid target.
- `404` conceals nonexistent sessions, non-membership, unauthorized owner-only resources, invalid invites, and revoked invites.
- `409` represents conflicts such as duplicate normalized agent name, stale queue order, owner leave, or any mutation on an ended session ("This session has ended."). `DELETE /api/account` returns `409 { code: "sessions_blocked", sessions }` when an owned session has live repository state (same class of conflict as `DELETE /api/sessions/[id]`'s `repository_state`/`integration_in_progress`), and writes nothing in that case.
- `403` with `{ code: "quota_exhausted" }` marks the session owner's monthly session-hours quota as spent — see "Plan limits and metering" below. `acceptInvite`'s seat-cap refusal returns `403` too, but without a machine-readable `code` today.
- Floor mutations return `{ floor }`; clients treat it as authoritative.

### Validation limits

Keep server validation in `lib/validation.ts` and cover it with unit tests.

- Profile first/last name (`parseProfileInput`, shared by onboarding and account settings): required, NFKC-normalized, whitespace-collapsed, maximum 50 characters each. GitHub handle: optional, trimmed, empty becomes null, maximum 39 characters.
- Avatar upload (`lib/account-avatar.ts`, shared by onboarding and account settings): PNG/JPEG/WebP only, maximum 5MB.
- Session title: required, trimmed, maximum 100 characters.
- Objective: nullable, trimmed, empty becomes null, maximum 2,000.
- Agent name: required, NFKC-normalized, whitespace-collapsed, maximum 24. Agent provider: optional, any known provider id, defaults to `openai`. Agent credentialKind: optional, must be a kind `credentialKindsForProvider` allows for the resolved provider; omitted/null means the owner's default.
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
- Provider credential (`parseCredentialConnectInput`): exactly one of `apiKey`/`setupToken` (trimmed single opaque token, no whitespace or control characters, maximum 512 characters) or `authJson` (trimmed JSON object string, maximum 8,192 characters, shape-checked: `tokens.account_id` and `tokens.access_token` strings).
- Imported skill (`parseSkillContent`, `lib/skill-validation.ts`): frontmatter `name` a lowercase slug (`[a-z0-9][a-z0-9-]{0,63}`), `description` required at most 500 characters, nonempty body, whole document at most 32,000 characters; 20 skills per session.
- MCP server (`parseMcpServerCreateInput`/`parseMcpServerUpdateInput`, `lib/mcp-config.ts`): lowercase-slug name with `openfloor` reserved, transport `http`/`sse`, https URL ≤ 2,048, ≤ 16 bounded headers; 10 servers per session.

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

### Enforcement points — spend initiators only

Deliberately **not** folded into `getActiveMembershipRole` (Persistence model, above): that function backs 22 call sites, and gating all of them at quota would strand an out-of-hours owner unable to revoke a leaked invite, turn auto-dispatch off, disconnect a repository, pause/delete a queue item, discard a run branch, or land already-completed work through review/merge — the wind-down set an owner must always retain, listed in full below. It would also throw into `worker/session-router.ts`'s bare `catch`, driving a permanent 60-second alarm retry loop for a condition (out of hours) that does not resolve until the month rolls over.

Instead, the quota gate sits at exactly four points, all "this is about to spend money or occupy a paid seat":

1. **`acceptInvite`** (`db/sessions.ts`) — seat cap only. One gate query; re-accepting as an already-existing member stays idempotent past the cap (`// ponytail:` comment documents the accepted check-then-insert race).
2. **The presence WebSocket upgrade** (`worker/presence.ts`'s `handlePresenceRequest`) — hour quota. Ended sessions are never gated (or metered); live sessions past quota get an accept-then-close with WebSocket code `4003`. Already-connected sockets are never kicked — the DO's booked total lags real usage by at most one `USAGE_FLUSH_INTERVAL_MS` (15 min).
3. **`startQueueItemRun`** (`lib/agent-run-start.ts`) — hour quota, returned as a `StartRunResult` union variant (`{ ok: false, kind: "quota_exhausted" }`), not thrown. This is the single seam covering both HTTP routes (`.../queue/[queueItemId]/run`, `.../runs/[runId]/retry`) *and* `worker/session-router.ts`'s auto-dispatch path, which has no HTTP layer to gate at all. `db/routing.ts` already treats any non-`"conflict"` failure kind as a session-wide precondition and holds with exponential backoff (`HELD_RETRY_BASE_MS` doubling up to `HELD_RETRY_MAX_MS`) — returning the variant gets correct backoff for free; throwing would not.
4. **Repository preflight and sync** (`lib/floor-api.ts`'s `quotaExhaustedErrorResponse`, called from both routes after `activeOwnerErrorResponse`) — hour quota. Unlike (3), a null `getOwnerHourQuota` result here fails closed (throws) rather than falling through, because `activeOwnerErrorResponse` has already confirmed the session and owner exist — a null result at that point is an invariant violation, not the ordinary shape of "unknown session" the way it is in `startQueueItemRun` (which runs before any such check).

**Never gated — the wind-down set.** An owner past quota must always be able to: read anything, send chat, edit/pause/delete queue items, cancel a run, revoke an invite, turn auto-dispatch off, disconnect a repository, discard a run branch, mark review ready, merge, end, leave, archive, and delete. None of these call the quota helpers; keep it that way.

### Metering

`SessionPresence` (per-session Durable Object, see Realtime model above) meters wall-clock time while at least one socket is connected, independent of how many sockets or which users:

- `ctx.storage` keys `clockStart`, `meterOwnerId`, `meterSessionId` are set once, on the first socket that carries `x-openfloor-meter-*` headers (set by `handlePresenceRequest`, stripped from the inbound client request first — these headers are Worker-internal, the same trust boundary as `lib/identity.ts`'s trusted-identity headers). A reconnect after hibernation never resets a running clock, because it's keyed on stored state, not live socket count.
- `flushUsage(keepRunning, endAtHint?)` books elapsed seconds to `usage_months` (upsert) and `sessions.active_seconds` (increment) in one D1 batch, on: occupancy hitting zero (`webSocketClose`), the 15-minute alarm while occupied, and `/session-ended`. `endAtHint`, when given, trims billing to a real timestamp earlier than "now" (see idle timeout below); the clamp — `min(now, max(clockStart, endAtHint))` — lives inside `flushUsage` itself so no caller can get either edge case wrong: an unclamped upper bound would silently lose the unbooked remainder on the next flush, and an unclamped lower bound can go *negative* (a stale `endAtHint` from an earlier flush interval predating the already-advanced `clockStart`) and, unclamped, would **decrease** `usage_months.seconds` through `seconds = seconds + excluded.seconds`.
- **Idle timeout (`IDLE_TIMEOUT_MS`, 30 min):** the same 15-minute alarm closes any socket whose `lastActivityAt` attachment field predates the cutoff, with close code `4004`, and books only up to that real last-activity timestamp — not up to the alarm firing. `lastActivityAt` is refreshed by typing updates and by a client-sent `"ping"` (`AgentFloorScreen.tsx` sends one every 30s, but only while `document.visibilityState === "visible"` *and* there has been real `pointermove`/`keydown`/`focus`/`scroll` input in the last 5 minutes) — an open-but-unattended tab, visible or not, stops refreshing it and eventually gets closed and stops billing.
- **Session end stops metering immediately**, even though sockets stay open (ended sessions remain readable — Persistence model, above): `/session-ended` calls `stopMetering()` (flush + clear `clockStart`/`meterOwnerId`/`meterSessionId`), and `alarm()` independently re-checks `sessions.ended_at` on every firing as a backstop for the case the `/session-ended` fetch never reached this DO instance (a mid-request crash between the D1 write and the DO call).
- Close codes in use: `4001` membership ended (terminal — client navigates to `/home`, does not retry), `4003` quota exhausted (terminal, no retry, shows the upgrade banner), `4004` idle (paused, not terminal — client reconnects on the next real input or `visibilitychange`, not on the exponential-backoff schedule the other close paths use).
- Accepted, bounded imprecision (see `// ponytail:` comments in `worker/presence.ts`): a flush interval spanning a UTC month boundary books wholly to the flush-time month; a DO crash around a flush can lose or double-count up to one `USAGE_FLUSH_INTERVAL_MS`. Hours are metered per session and summed onto one monthly total — an owner running two sessions concurrently burns the month at 2x wall-clock; `HomeScreen`'s usage line says so explicitly when it detects more than one live owned session, rather than let it read as a billing bug.

### Stripe billing lifecycle

Stripe is authoritative for external subscription state; D1 is the authoritative product entitlement projection. Checkout/customer/subscription metadata and `client_reference_id` bind the purchase to the already-authenticated internal user ID, so there is never an email lookup or a silent zero-row grant. The public webhook verifies Stripe's raw-body signature, claims each event ID once, persists a subscription snapshot, applies event-time ordering, and then projects `users.plan`, `plan_status`, and `seat_limit`.

`/settings`'s Plan & usage tab (`components/product/SettingsScreen.tsx`) is the single plan-management surface: current effective limits, status, billing period, Pro/Max selection and quantity, confirmed prorated change, general Portal management, and Enterprise contact. `HomeScreen` and `Workspace` quota banners link there because they are enforcement feedback at the point a limit bites.

Normal Portal cancellation is immediate. Account deletion performs immediate Stripe cancellation with no refund before scrubbing D1. The Portal configuration is external dashboard state and must restrict changes to the two configured prices, enforce their quantity ranges, apply prorations immediately, and cancel immediately; see `docs/stripe-billing.md`. `STRIPE_CHECKOUT_ENABLED` stays false until all Stripe configuration, secrets, migrations, webhook delivery, and acceptance checks are ready.

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
- `ObjectiveBar.tsx`: persistent member-editable objective; an owner-only nudge banner opens the same editor once public chat has outpaced the objective's last edit.
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
- Theming: the bare `:root` block in `tokens.css` is Light; the dark values live twice (under `prefers-color-scheme` guarded against every manual theme, and under `:root[data-theme="dark"]`) and must stay identical. Polar is the cool near-white manual variant and Midnight is the near-black manual variant. `components/ThemeToggle.tsx` cycles System → Light → Polar → Dark → Midnight, persisting the manual choice in localStorage (`openfloor:theme`); an inline script in `app/layout.tsx` applies it pre-paint. Never hardcode a color a theme must change — the code workbench's inverse surfaces are the deliberate exception (dark in every theme).
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
  billing.ts                 Stripe customer/subscription/event persistence and entitlement projection
  provider-credentials.ts    Encrypted per-user provider credential rows and owner resolution
  skills.ts                  Owner-gated session skill imports and run materialization reads
  mcp-servers.ts             Owner-gated MCP server config with encrypted headers and run reads
  floor.ts                   Prepared D1 floor snapshot and mutation queries
  repositories.ts            Owner-gated GitHub connection and check-command persistence
  preflights.ts              Durable preflight/check state and internal Workflow transitions
  runs.ts                    Durable agent-run lifecycle, checks, files, artifacts, and execution context
  session-context.ts         Session-scoped, member-neutral floor read for the agent brief (D1)
drizzle/                     Generated D1 migrations and metadata
lib/
  floor-types.ts             Public persisted floor types
  session-types.ts           Session, identity, presence, and typing event types
  session-context.ts         Pure session-brief renderer (no D1); shared by dispatch and live re-read
  validation.ts              Bounded input parsing and normalization
  identity.ts                Access verification and local identity isolation
  invites.ts                 HMAC signing and constant-time verification
  stripe.ts                  Stripe client, bindings, and webhook signature verification
  stripe-billing.ts          Checkout, Portal, reconciliation, and account-cancellation orchestration
  credential-crypto.ts       AES-GCM encryption at rest for provider credentials
  provider-credentials.ts    Pure provider/credential types, per-provider default models, run resolution order
  provider-validation.ts     Connect-time key validation against provider models endpoints
  claude-sandbox-settings.ts Pinned Claude-runner sandbox posture serializer
  skill-validation.ts        Bounded SKILL.md frontmatter parsing and slug rules
  mcp-config.ts              Provider-neutral MCP server types, bounds, and per-provider serialization
  github.ts                  GitHub App JWT, installation-token, repository, and branch reads
  github-state.ts            Signed callback state and webhook HMAC verification
  runtime-token.ts           Short-lived preflight/run operation-scoped gateway JWTs
  presence-server.ts         Internal application-to-Durable-Object notifications
  floor-api.ts               Shared floor route response helpers
  floor-state.ts             Pure queue/mention/revision/objective-nudge client helpers
  typing-drafts.ts           Pure live-draft reducers and visibility selection
worker/
  index.ts                   Cloudflare entry, identity boundary, assets, app dispatch
  presence.ts                Authenticated WebSocket route and SessionPresence object
  preflight-workflow.ts      Durable exact-source Sandbox preflight orchestration
  agent-run-workflow.ts      Durable Codex/check/cancellation Sandbox orchestration
Dockerfile.sandbox           Version-matched Cloudflare Sandbox runtime image
.github/workflows/deploy.yml Push-to-main production deploy (test → migrate → build → deploy)
scripts/codex-runner.mjs     Pinned server-side Codex SDK runner inside the Sandbox image
scripts/claude-runner.mjs    Pinned Claude Agent SDK runner (non-root, kernel-sandboxed) in the same image
scripts/gemini-runner.mjs    Pinned Gemini CLI runner (non-root, srt-wrapped) in the same image
scripts/gemini-proxy-preload.mjs  Fetch preload making the Gemini CLI honor srt's proxy env on Node 22
scripts/openfloor-mcp.mjs    Read-only stdio MCP server exposing openfloor_session_context to Codex
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
- Stripe signature rejection, event replay/order behavior, plan/status/quantity projection, paid-onboarding completion, and dynamic invite seat enforcement.
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

`STRIPE_CHECKOUT_ENABLED` gates new Checkout and plan-change flows. Keep it false until both exact monthly prices, the restricted Portal configuration, all Stripe secrets, D1 migrations, public webhook delivery, and test-mode acceptance in `docs/stripe-billing.md` are complete. Existing entitlement reads and signed webhook reconciliation do not depend on this gate.

`CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, and `GEMINI_RUN_ENABLED` independently gate their providers' runs (one flag per provider id; `disabledRunProviders()` in `lib/agent-run-start.ts` is the single reader). For each: keep it `false` until the deploy containing its code (and any bumped image) is live, its gateway route is reachable, and a credential resolves (owner-connected or server) — then run the per-provider acceptance runbook (staging session, full run arc, gateway rejected-path log review) before flipping. While a flag is false, a *manual* start of that provider's item refuses as `disabled` at the `startQueueItemRun` seam, agent *creation* for it refuses with `503`, and *auto-dispatch* skips its items per-item (`RoutingDeps.disabledProviders`) so they never hold the rest of a mixed queue; other providers' runs are unaffected either way. Rollback = flip back: existing agents persist and degrade correctly.

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
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRO_PRICE_ID`
- `STRIPE_MAX_PRICE_ID`
- `STRIPE_PORTAL_CONFIGURATION_ID`
- `CREDENTIAL_ENCRYPTION_KEY`
- `ANTHROPIC_API_KEY` (optional: the server-side fallback for Claude runs; without it, a Claude run requires the agent owner's connected key)
- `MOONSHOT_API_KEY` (optional: same contract for Kimi runs)
- `GEMINI_API_KEY` (optional: same contract for Gemini runs)

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

1. Open public `https://app.opnflr.com` without an Access session.
2. Sign in through a protected path and verify return to `/home`.
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
- `BASE_PATH` is `""` in every environment (the app owns `app.opnflr.com` outright); it's kept wired through rather than deleted in case a path prefix is needed again later.
- Next `Link` and manual `fetch` have different base-path responsibilities, even though `BASE_PATH` is currently empty.
- Cloudflare Access configuration is external state; code passing locally does not prove the production policy paths are correct. The hosted login screen's branding is dashboard-applied too — steps in `docs/cloudflare-access-branding.md`.
- The Worker claims `app.opnflr.com` via a `custom_domain: true` route in `wrangler.jsonc`, which has Cloudflare manage the DNS record.
- Access protects the app at the edge, but the Worker still verifies JWTs. Do not remove defense in depth.
- `/webhooks/github` is deliberately public and must never process a payload before its raw-body HMAC and size are verified.
- `/webhooks/stripe` is deliberately public and must never process a payload before its 256 KB limit and raw-body Stripe signature are verified. Cloudflare Access must not protect it.
- Stripe Portal behavior is dashboard state: the configured Portal must allow only the two exact monthly prices and their seat quantities, prorate changes immediately, and cancel immediately. A permissive Portal configuration weakens application-side validation.
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

An owner cannot remove a member from a session today — `leaveSession` is self-service only and refuses owners. At a 3-seat free tier, one mis-sent invite permanently consumes a third of a session's capacity with no in-product remedy. An owner-initiated remove-member action is the next plan-limits-adjacent piece of work; it needs its own decision about notifying the removed member (`disconnectPresenceUser` and WebSocket close code `4001` already exist and would cover it).

## Key decision log

### 2026-08-19 — Pushes to main deploy production via GitHub Actions

**Decision:** `.github/workflows/deploy.yml` runs the documented deploy sequence — `npm test`, `wrangler d1 migrations apply DB --remote`, `npm run build`, `wrangler deploy --config dist/server/wrangler.json` — on every push to `main`, serialized by a `production-deploy` concurrency group that never cancels in-flight runs. Auth comes from repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; Worker runtime secrets stay in Cloudflare and are untouched by CI.

**Rationale:** The runbook was four commands executed by hand, so production lagged merged work and depended on someone remembering the order (migrations before code). Encoding the same sequence in CI changes when it runs, not what runs. GitHub Actions over Cloudflare Workers Builds because the pipeline lives in the repo, is reviewable, and needs no dashboard state beyond two secrets.

**Consequences:** Merging to `main` is deploying — the full test pipeline still gates it, but a red deploy job means production did not pick up the merge; check the Actions log. Migrations apply before build/deploy, same as the manual order. The e2e step installs Playwright chromium in CI; the sandbox container image builds on the Actions runner's Docker. The job has read-only repository permission, and Cloudflare secrets exist only on the migration and deploy steps so install scripts, tests, and builds cannot read them. Rotating the API token happens in GitHub repo secrets, not in code.

### 2026-08-19 — Two themes from one token sheet

**Status:** Superseded by “Add Polar and Midnight as explicit manual product themes” (2026-08-22); retained for history.

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

### 2026-08-18 — Mount the product under `/app` (superseded 2026-08-23)

**Decision:** Keep the marketing site at the apex and serve openfloor under `opnflr.com/app` in production; serve at root in local development.

**Rationale:** Marketing and product are separate deployments on one domain, and vinext development stylesheet behavior does not tolerate the production prefix cleanly.

**Consequences:** Next base-path configuration, manual `BASE_PATH` use, Worker asset stripping, Access paths, invite URLs, WebSocket URLs, tests, and smoke tests must all preserve the distinction. Superseded by the 2026-08-23 subdomain decision below: the app now owns `app.opnflr.com` outright, `BASE_PATH` is `""` everywhere, and dev/production parity no longer needs a distinction.

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

**Consequences:** The app requests Metadata read, Contents read/write, Pull Requests read/write, Checks read, and Commit statuses read, with no Administration or Workflows permission. The write grants are reserved for later accepted phases; generic branch CRUD, force push, base-branch writes, and protection changes are never exposed. The original isolated-development deployment consequence was superseded on 2026-08-19; phased acceptance now uses production openfloor with repository access limited to a disposable repository.

### 2026-08-19 — Target Workflows, Sandboxes, Codex, and a single candidate PR

**Decision:** The accepted target architecture uses Cloudflare Workflows for durable orchestration, Cloudflare Sandboxes for isolated repository work, and the server-side Codex SDK with `gpt-5.6-terra`. Owner-authorized passing runs will eventually publish server-generated run branches, integrate automatically into one active candidate branch, maintain one draft pull request per candidate, and allow only the owner to request the final squash merge.

**Rationale:** Durable workflows provide restart/retry semantics, sandboxes isolate untrusted repository commands, short-lived service credentials keep secrets out of repository processes, and a single candidate PR gives human reviewers one stable integration surface while preserving individual run attribution.

**Consequences:** This entry records the future architecture but does not make later-phase behavior real. Cloudflare Workflow, Sandbox, R2, Codex, branches, checks, run records, pull requests, integration, and merge remain absent until their named accepted phases. GitHub protections remain authoritative and workflow-file changes stay excluded while the App lacks Workflows permission.

### 2026-08-19 — Temporarily deliver repository phases directly to production

**Decision:** Until the user establishes a staging environment, deploy each accepted repository-execution phase to the existing production openfloor Worker and D1 database at `opnflr.com/app`. Use a real disposable GitHub repository as the only App installation target during acceptance.

**Rationale:** Reusing the working production application, Access policy, domain, and bindings removes a second environment's DNS, Access, secret, and deployment setup from the critical path. A disposable repository limits the GitHub-side impact while the integration matures.

**Consequences:** The unused `openfloor-development` D1 database may remain for later cleanup but is not referenced by application configuration. Production migrations must precede code deployment. The five GitHub App secrets must be configured before deploying the repository UI, and each phase must still pass the complete pipeline and stop for explicit browser acceptance. Expanding the App beyond the disposable repository requires a separate deliberate decision.

### 2026-08-19 — Allow repository connection before checks are configured

**Decision:** Required-check commands are optional when an owner connects or configures a repository. The connection displays an explicit unconfigured state when the command list is empty.

**Rationale:** Repository authorization and selection are useful independently of knowing the repository's test commands. Requiring commands during connection prevents owners from completing GitHub setup and discovering the repository before deciding how it should be verified.

**Consequences:** The repository API accepts zero to eight commands. Future preflight, agent-run, publication, and integration actions must fail closed until the owner configures at least one command; an empty list must never be treated as a passing check suite.

### 2026-08-19 — Reconcile one immutable candidate ref without automatic repair (branch format superseded)

**Decision:** Enabling execution creates one durable active candidate at the current configured base SHA on a server-generated `openfloor/<session-short>/candidate/<candidate-short>` ref. openfloor records expected and observed SHAs, treats GitHub as authoritative, and reports a newer base as behind or an unexpected candidate head as externally modified. It never force-pushes or repairs either condition in Phase 2.

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

**Decision:** Owner-only discard first reconciles the remote run head and then deletes through a fixed Git push using `--force-with-lease` for the recorded SHA. openfloor never exposes arbitrary ref deletion and never deletes a candidate or base branch through this action.

**Rationale:** GitHub's REST ref deletion endpoint has no conditional expected-SHA parameter, leaving a race between read and delete. A Git lease makes the remote head comparison atomic with deletion.

**Consequences:** External push webhooks update each run's observed remote SHA. Any mismatch, missing branch, wrong status, non-openfloor ref, or lease failure returns a conflict and preserves the branch. Successful discard deletes only the GitHub ref; all run, check, file, diff, bundle, event, and attribution records remain durable.

### 2026-08-19 — Resume publication from durable bundle state

**Decision:** GitHub installation tokens authenticate Git-over-HTTPS as the password for the fixed `x-access-token` username, encoded as an HTTP Basic authorization header that is never written into the repository URL. A restarted run Workflow detects `publishing` and resumes validation/publication from its stored bundle, recorded files, and local commit instead of rerunning Codex or checks.

**Rationale:** GitHub's REST API accepts Bearer tokens, but its documented Git transport uses the installation token as an HTTP password. Publication is a distinct recoverable stage, and repeating paid agent execution after a transport or deployment failure would be slow and could produce different code.

**Consequences:** Each Workflow instance receives a distinct publisher Sandbox identity so a recovery cannot reuse a stale container image. The clean publisher and discard Sandbox receive the short-lived Git credential only through their process environments; Git clone, push, and conditional deletion all use the same HTTP Basic transport contract, while REST calls continue to use Bearer authentication. Error messages never include the header or token and distinguish an actual expected-SHA lease mismatch from authentication or transport failure. Publication retries remain idempotent because an existing run ref is accepted only at the exact trusted commit, and the Workflow reconciles the remote SHA before recording success.

### 2026-08-19 — Serialize run integration into one candidate and draft PR

**Decision:** After publication, `AgentRunWorkflow` acquires a conditional D1 lease on the active candidate, reconciles the current base/candidate/run refs from GitHub, and requests GitHub's non-force branch merge using the immutable run commit as the head. The first successful integration creates one draft PR from candidate to configured base; later integrations advance that same branch and PR. A GitHub merge conflict records `conflicted`, preserves both branches, and owner-only retry creates a new run attempt from the latest candidate.

**Rationale:** Per-run branches isolate concurrent agent work, while a single serialized candidate gives reviewers one stable integration surface. The D1 lease prevents two Workflows from updating the expected candidate head concurrently, and GitHub remains authoritative for the actual merge result and conflict decision.

**Consequences:** Candidate records persist the integration lease and PR number/node/URL/state/draft metadata. Runs persist integration base, integrated candidate SHA, conflict reason, and timestamps. Successful integration marks the queue item completed; conflict leaves it blocked. Candidate push webhooks received while the matching lease is held do not falsely mark openfloor's own merge as an external mutation. Final PR readiness, protection enforcement, squash merge, and cleanup remain Phase 7.

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

**Consequences:** Candidate refs now have the form `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>`. Names are NFKC-normalized and limited to 100 characters; descriptions are trimmed and limited to 2,000. Existing candidates are backfilled from their session title/objective. Members can read the metadata, only owners create candidates, and openfloor still controls the prefix, suffix, non-force creation, reconciliation, merge, and cleanup rules.

### 2026-08-20 — Give every dispatched agent a unified session brief

**Decision:** `AgentRunWorkflow` no longer prompts an agent with only its own queue request. `db/session-context.ts` reads a bounded, session-scoped snapshot of the whole floor — every agent and human assignment, already-integrated run summaries and files, other runs currently in flight with their live file-edit activity, the rest of the queue, blocked/failed runs, prior attempts on the same queue item, and the last 30 public team-chat messages — and `lib/session-context.ts` renders it into one prompt alongside the agent's own request and the existing safety rules. The read takes no `userId`; its chat query is hard-coded to `recipient_user_id IS NULL`, so direct messages are structurally unreachable rather than filtered out after the fact. The render is capped at 24,000 characters: each section truncates to a documented per-item limit with an explicit remaining count, and if the assembled brief is still over budget, whole lower-priority sections are dropped in a fixed order (team chat first, "who else is on this floor" last) with a one-line marker; the agent's own request and the header are never dropped.

**Rationale:** openfloor's product premise is a shared floor, not isolated chat windows, but the agents were the one participant that could not see it — `SESSION_RUN_CAP = 2` routinely runs two agents against the same candidate with no awareness of each other, so the second one only discovers the collision as a GitHub 409 on integration. Every fact needed already existed in D1; this closes a rendering gap, not a data gap. A snapshot at dispatch keeps the Workflow step deterministic and replay-safe across retries, the same contract the pinned candidate SHA already has.

**Consequences:** The rendered brief is unit-tested in isolation from D1 (`tests/unit/session-context.test.ts`) and the D1 read is covered by `tests/worker/session-context.test.ts`, including an explicit assertion that a direct message never reaches the snapshot. `runTestAgent` (`lib/agent-run-start.ts`) does not exercise this path — it never writes a prompt file — so the test-adapter run flow remains unchanged. The two follow-ups noted here at the time — a live mid-run re-read and persisting the brief as a visible artifact — are now built; see the next two entries.

### 2026-08-20 — Let a long-running agent re-read the session brief mid-run

**Decision:** The Sandbox exposes a read-only `openfloor_session_context` MCP tool (`scripts/openfloor-mcp.mjs`) to Codex via the SDK's `config.mcp_servers`, backed by a new `GET /runtime/run/context` gateway route and a new `"context"` `RunGatewayClaims` operation (60-minute TTL, same as `events`/`openai`). The route calls the same `db/session-context.ts` + `lib/session-context.ts` pipeline the dispatch-time prompt uses, so a re-read reflects genuinely current D1 state — not a cached copy. Tool calls appear in the activity timeline as a new `tool_call` event kind.

**Rationale:** Codex's shell sandbox runs with `networkAccessEnabled: false`, but MCP child processes are spawned by the Codex CLI outside that sandbox and keep their network — the only legitimate bridge from a network-isolated agent back to live session state. Runs can last up to 60 minutes; the dispatch-time brief goes stale well before that.

**Consequences:** The gateway token and its MCP-child env vars are passed explicitly (`OPENFLOOR_CONTEXT_URL`/`OPENFLOOR_CONTEXT_TOKEN`) rather than relied on to inherit from the runner process, since the Codex CLI's own env-inheritance behavior for MCP children isn't part of its documented TypeScript surface. Pooled run sandboxes are keyed only by `repository_id` (`db/sandbox-pool.ts`), so a container built from a stale image would otherwise stay claimable for up to `POOL_IDLE_TTL_MS` after a deploy; `RUN_SANDBOX_IMAGE_VERSION` in `worker/agent-run-workflow.ts` namespaces the pool key by image version and must be bumped whenever `Dockerfile.sandbox`'s run-sandbox contents change, the same discipline `PUBLISHER_SANDBOX_IMAGE_VERSION` already has for the publisher sandbox. `@modelcontextprotocol/sdk` is a new dependency, installed into both the sandbox image and the top-level `package.json` (matching how `@openai/codex-sdk` is tracked) though only the sandbox-image copy ever runs.

### 2026-08-20 — Make the dispatched brief visible, and nudge the owner when the objective drifts

**Decision:** The exact prompt a run received is persisted as an `agent_run_artifacts` row of kind `prompt` (UPSERT-keyed like the existing kinds; TS-enum only, no new SQL CHECK) and exposed through a second Agent-card expander, "Session brief sent to this agent," beside the existing raw-log expander. `GET /api/sessions/[id]/runs/[runId]/artifacts` keeps its default (unfiltered) output byte-for-byte unchanged — `codex_log` + `diff` only — and now accepts an explicit `?kind=` to return exactly one artifact with no heading. Separately, a new `sessions.objective_updated_at` column (set only by `updateSessionObjective`) tracks when the objective itself last changed; once `OBJECTIVE_NUDGE_THRESHOLD` (10) public team messages postdate it, `ObjectiveBar` shows an owner-only banner that opens the same inline editor. The count (`lib/floor-state.ts`'s `countMessagesSinceObjective`) excludes direct messages and is computed client-side from data already in `FloorSnapshot` — no new mutation or endpoint.

**Rationale:** Injecting context an agent can act on, without any way for a human to see exactly what it was told, would work against the trust the rest of this system is built on. Separately, `sessions.updated_at` looked like a plausible staleness signal for the objective but isn't one: `bumpFloorRevision` advances it on every floor mutation, including the very chat messages a staleness check would want to count — using it would have made the nudge a permanent no-op, discovered while implementing this feature rather than by design.

**Consequences:** Migration `0016` adds `objective_updated_at NOT NULL DEFAULT 0`, then backfills existing rows to their current `updated_at` (SQLite `ADD COLUMN` can't default to another column's value, so the backfill is a second statement in the same migration). `createSession` and `updateSessionObjective` are the only writers. `tests/worker/sessions.test.ts` asserts the isolation directly: creating an agent and sending a message must not move `objectiveUpdatedAt`, only an objective save can.

### 2026-08-20 — Close the plan-limits gaps: quota-gate placement, metering correctness, and a non-recreate free tier

**Decision:** Following a review of the initial plan-limits work (seat caps, hour quota, presence metering), this closes eight gaps in one PR, split across seven commits. Two were live defects: `handlePresenceRequest` copied client headers verbatim and only overwrote the metering headers on the live-session path, so a forged `x-openfloor-meter-owner-id` against an *ended* session booked hours to an arbitrary user (fixed by unconditionally stripping both headers before the gate runs); and `/session-ended` left `clockStart` running, so an occupied ended session kept billing invisibly (fixed by `stopMetering()` plus an `alarm()` backstop that independently notices `sessions.ended_at`). The rest is new: a 30-minute idle timeout (close code `4004`) with billing trimmed to real last activity rather than detection time; a `free` tier represented as a synthetic `effectivePlan()` value rather than a stored `plan` enum member, with a new `plan_status` column added via plain `ALTER TABLE` (not the table recreate `drizzle-kit generate` naturally produces for a new column backed by a named CHECK — see the `users` invariant in "Persistence model" above); quota gating extended from presence-only to the actual spend initiators (run dispatch via a `StartRunResult` variant, repository preflight/sync); and the usage/upgrade UI described in "Plan limits and metering" above.

**Rationale:** The header-stripping bug mirrors exactly the convention `lib/identity.ts` already states for its own trusted headers — the fix generalizes an existing pattern rather than inventing one. The quota-gate placement (spend initiators, not `getActiveMembershipRole`) was a live design fork: folding quota into the general write guard was tried first and rejected after tracing it against all 22 `getActiveMembershipRole` call sites — it would have blocked an out-of-hours owner from revoking a leaked invite, disabling their own auto-dispatch loop, or landing already-finished review work, and would have turned a persistent "out of hours" condition into a 60-second hot retry loop in `worker/session-router.ts`'s bare catch. The free-tier schema question was a similar fork, discovered empirically: the original plan called for recreating `users` with a literal `'free'` value (justified as safe because production was believed to have no rows yet); rehearsing that migration locally against seeded data — before ever touching remote — showed it cascade-deletes `session_members`/`session_invites`/`github_connection_states` despite the generated `PRAGMA foreign_keys=OFF` wrapper, and a remote row-count check found production already has 5 users, 9 sessions, 12 session_members. The synthetic-value approach (mirroring how `0018` was already hand-fixed for the same reason) gets the identical entitlement behavior with zero migration risk.

**Consequences:** `lib/plans.ts` is now the single source for `Plan`/`PlanStatus`/`PLAN_LIMITS`/`effectivePlan`/`currentMonth`, re-exported from `db/sessions.ts` for existing importers; it has no `cloudflare:workers` import specifically so it stays reachable from `tests/unit`. `getOwnerHourQuota` returns the *effective* plan, not the raw purchased one — a caller that indexes `PLAN_LIMITS` by a raw `plan` field again would hand a lapsed Max owner 100h. `getOwnerHourQuota` and the presence gate now fail closed (throw) on a missing owner row rather than silently connecting ungated; `lib/agent-run-start.ts`'s use of the same function deliberately does not, because it runs before any existence check and a throw there would turn an ordinary "unknown session" into an unhandled 500 instead of the existing 404. Migration `0019` is a two-statement `ALTER TABLE ADD` plus an `UPDATE` backfilling existing rows to `plan_status = 'active'`; do not attempt to consolidate a future `plan`-column change into a recreate without re-rehearsing against seeded data first. The payment-link/manual-grant consequence was superseded by the 2026-08-21 Stripe billing decision below.

### 2026-08-21 — Build a complete account settings surface, consolidating every scattered settings affordance into it

**Decision:** Added `/settings` (`app/settings/page.tsx`, `components/product/SettingsScreen.tsx`) covering profile editing (name, GitHub handle, avatar upload/removal), plan and usage, preferences (Do Not Disturb, theme), and account deletion. It is reached from a new `AccountMenu` (`components/product/AccountMenu.tsx`) behind the avatar in both headers, replacing the bare non-interactive avatar, the duplicated `ThemeToggle`/`DoNotDisturbToggle`/sign-out pairs in `AppHeader.tsx` and `TopBar.tsx`, and the floor-only `SettingsDialog` (deleted) whose "Profile"/"Appearance" rows were permanently stubbed "Coming soon." New DB writers: `updateProfile` (three-state avatar argument, unlike onboarding's add-only `COALESCE`) and `deleteAccount` (see the "Account deletion" note under `users` in Persistence model, above). Resolved three forks along the way, each with a narrower alternative rejected:

- **Email stays read-only, IdP-owned.** Cloudflare Access is the only identity provider (`app/access-auth.ts`) and `upsertUser` refreshes `email` from its JWT on every login while also using it as the account-matching fallback when Access issues a different `sub` per login method — a user-editable email field would silently revert at next sign-in and could collide with that fallback match. `/settings` shows it with an explanation instead of a dead input.
- **Account deletion scrubs and releases the identity rather than hard-deleting the row.** A real `DELETE FROM users` fails outright: roughly a dozen columns across `floor_messages`, `floor_agents`, `repository_candidates`, and others reference `users.id` with no cascade action, and the existing `users`-must-never-be-recreated invariant (three inbound `ON DELETE CASCADE` FKs, confirmed by rehearsal during the plan-limits work) rules out adding cascades via a table-swap migration. Scrubbing `chatgpt_user_id`/`email` to values the IdP can never present again, clearing profile fields, and stamping a new `deleted_at` tombstone gets the same practical outcome (the account is gone, a fresh sign-in starts clean) with a plain `ALTER TABLE ADD COLUMN`.
- **A blocked owned session refuses the whole deletion rather than force-deleting repository state.** `deleteAccount` reuses `deleteSession`'s exact guards (`getBlockingIntegrationRunId`, live `repository_candidates`) per owned session before writing anything, because those D1 rows hold the leases needed for external (GitHub) cleanup — the same reasoning `purgeExpiredSessions` already applies to retention. Force-deleting through it would either abandon a live GitHub integration mid-flight or silently orphan the lease record.

**Rationale:** Each fork picked the option that added zero migration/authorization risk over one that would have required either a schema change disallowed by an existing invariant, a new backend capability (a customer portal, an email-change flow) with no product need yet, or bypassing a safety guard another code path already established for the same class of state. The consolidation (one `AccountMenu`, one `/settings`) removes duplicated controls that had drifted apart (the floor `TopBar` had Theme/DND/sign-out; `AppHeader` had the same three independently) rather than adding a fourth copy.

**Consequences:** `lib/display-name.ts` is now the single source for `displayNameFrom`/`initials`/`initialsFromParts`, used by onboarding, account settings, and every avatar label — the three previous ad hoc copies (`completeOnboarding`'s inline template literal, `AppHeader.tsx`'s exported `initials`, `OnboardingScreen.tsx`'s inline initials math) are gone. `lib/account-avatar.ts` (server, R2-bound) and `lib/avatar-constraints.ts` (client-safe constants, split out specifically because `account-avatar.ts` imports `cloudflare:workers` and cannot enter a `"use client"` bundle) are the only place avatar size/type limits and the R2 key layout are defined; onboarding's upload route was rewritten to call them instead of inlining the logic a second time. `Avatar` (`components/session/primitives.tsx`) gained `version` (cache-busts the 5-minute R2 response against `user.updatedAt` after an edit) and `previewSrc` (a local object URL for an unsaved picker selection) — roster avatars that only have a `SessionMember`, not a full `AppUser`, still accept up to 5 minutes of staleness for other people. `usage_months` and other users' authored floor content are untouched by deletion by design; anything that later changes that must re-read the "Account deletion" contract in Persistence model first. The no-Stripe/manual-grant consequence was superseded by the 2026-08-21 Stripe billing decision below.

### 2026-08-21 — Make paid onboarding and entitlement fully Stripe-backed

**Decision:** Direct first-login onboarding requires an explicit Free, Pro, or Max selection; a currently valid signed-invite return receives Free automatically, while Enterprise remains sales-managed. Pro is USD $30 per seat per month for 3–5 seats and 30 session-hours per month; Max is USD $50 per seat per month for 3–10 seats and 100 hours. Stripe Checkout creates monthly subscriptions bound to the authenticated internal user ID, Customer Portal owns billing management and confirmed immediate prorated plan/quantity changes, and a public raw-body-signed webhook projects subscription lifecycle into `users.plan`, `plan_status`, and `seat_limit`. Purchased quantity caps every session the buyer owns independently.

**Rationale:** A public Payment Link plus manual email-based SQL could accept money without changing the product, could not grant a buyer who had no user row, and could sell only one indistinguishable tier. Starting Checkout only after authenticated profile submission guarantees a row and a stable internal binding; separate configured Price IDs distinguish Pro/Max; Stripe remains authoritative for billing while a bounded D1 projection keeps quota and seat checks local and reload-safe. A rollout gate keeps paid CTAs from accepting payment before prices, Portal policy, webhook, secrets, migrations, and deployment are complete.

**Consequences:** Added `stripe_customers`, `stripe_subscriptions`, `stripe_webhook_events`, and nullable `users.seat_limit` through migration `0024` (renumbered after `main` added provider migration `0023`); `users` is never recreated. Webhook event IDs deduplicate replay, `event_created` rejects stale subscription rollback, and unknown price/quantity fails entitlement closed. Active/trialing paid state completes a pending profile; paid cancellation or delinquency falls back to Free. Existing manual active Pro/Max grants with null quantity remain at 5/10 seats and active Enterprise wins over Stripe. Normal Portal cancellation is immediate; account deletion cancels known subscriptions immediately without refund and refuses to scrub the account if Stripe cancellation fails. The external Portal configuration must restrict products/quantities, apply immediate prorations, and cancel immediately. Production must keep `STRIPE_CHECKOUT_ENABLED=false` until `docs/stripe-billing.md` acceptance is complete.

### 2026-08-21 — Store user provider credentials encrypted under a Worker secret, resolved per run as owner-else-server

**Decision:** New table `user_provider_credentials` keyed `(user_id, provider)` holds per-user API keys for agent providers (`anthropic` and `openai` today), managed from `/settings` → Connections. Values are encrypted at rest with AES-256-GCM: the key is derived (SHA-256) from a new `CREDENTIAL_ENCRYPTION_KEY` Worker secret, each write uses a fresh 96-bit IV, and `"<userId>:<provider>"` is bound as AAD. Keys are validated on connect against the provider's free models endpoint and are write-only from the client — every read returns only provider, kind, a last-four fingerprint, and timestamps. Per run, the credential gateway resolves in a fixed order: the **session owner's** connected key for the run's provider, else the server-configured key, else refuse the run with a clear `503`; a present-but-undecryptable owner key also refuses. `provider` and `kind` are TS-typed open enums with no SQL CHECK. `kind` is `api_key` only; the schema accepts a future `kind: "oauth"` row unchanged, but claude.ai/Max/Pro subscription login is not built — Anthropic does not allow third-party products to offer claude.ai login without prior approval. *(Partially superseded 2026-08-24 — "Credential kinds become first-class" below: `kind: "oauth"` rows now exist as pasted setup-token/auth-bundle credentials with a widened `(user_id, provider, kind)` key; an openfloor-operated OAuth login remains unbuilt.)*

**Rationale:** Encryption key from a Worker secret rather than a KMS binding because no KMS binding exists in this stack and Worker secrets are the established channel for exactly this class of material (`INVITE_SIGNING_SECRET`, `GITHUB_STATE_SECRET`); AES-GCM via WebCrypto needs no new dependency. Owner-else-server rather than initiator-else-server because the owner is who the plan quota already bills — the two "who pays" ledgers should not diverge. Refusal instead of silent server-key fallback whenever an owner credential exists but fails, because a run that silently switches payer mid-stream is a billing surprise and masks a broken key the owner believes is active. Open TS-only enums follow the `agent_run_artifacts.kind` precedent and the `users`-recreate invariant's lesson: a CHECK-constrained column change on a live table is a table recreate away from cascade data loss.

**Consequences:** `CREDENTIAL_ENCRYPTION_KEY` joins the required secrets (README, `docs/github-production.md`, `.env.example`, both vitest configs); rotating it invalidates every stored credential and users must reconnect — there is no re-encryption path. `users` now has four inbound `ON DELETE CASCADE` FKs (the never-recreate invariant tightens), and `deleteAccount` deletes credential rows explicitly because the scrub never fires the cascade. The OpenAI gateway no longer requires `OPENAI_API_KEY` to exist before verifying the token — resolution happens after authentication, and its rejection paths are covered by `tests/worker/credentials.test.ts` (registered in the `test:worker` script list, which enumerates files explicitly). Connect-time validation uses the `OPENFLOOR_TEST_PROVIDER_KEYS` deterministic adapter in tests, following `OPENFLOOR_TEST_GITHUB_DATA`. The Claude runner (next milestone piece) consumes the same store through an equivalent Anthropic gateway; provider/model selection per agent remains deferred until that runner exists.

### 2026-08-21 — Owner-configured remote MCP servers, connecting directly from the run container

**Decision:** Session owners configure up to 10 remote MCP servers per session (`session_mcp_servers`: lowercase-slug name with `openfloor` reserved, transport `http`/`sse`, https URL, optional bounded headers, enabled flag). Header values are encrypted at rest under `CREDENTIAL_ENCRYPTION_KEY` (AAD `mcp:<row id>`) and are write-only — every read returns header names, not values. The internal runtime type (`lib/mcp-config.ts`) is provider-neutral; `serializeMcpServersForClaude` emits the Agent SDK's `{type, url, headers}` shape, and enabled servers reach the Claude runner with their tools allow-listed per server (`mcp__<name>` in `allowedTools`) — required because `dontAsk`'s per-tool defaults vary (the §2 empirical finding), so MCP tool availability is explicit configuration, never a permission-mode default. The always-present `openfloor_session_context` server is not user-removable, and the reserved name is enforced at validation, at serialization, and again in the runner. v1 defers `stdio` transports and builds no openfloor-controlled egress proxy. The Codex serializer intentionally does not exist yet, but its target contract is now **verified, not assumed**: the pinned `codex-cli 0.148.0` binary (vendored by `@openai/codex-sdk`, interrogated via `codex mcp add --url` and its generated `config.toml`) supports remote MCP servers as `[mcp_servers.<name>]` with `url` (transport `streamable_http`), an `http_headers` map, `bearer_token_env_var`, and OAuth login. So the internal type's `name`/`url`/`headers` map onto Codex cleanly when parity work happens — with one honest gap: the `sse` transport openfloor accepts has **no Codex equivalent** at this pin; an sse-transport server would serialize for Claude only.

**Rationale — what this changes, stated honestly.** The control here is owner-gating plus the reserved-name list — *not* a claim that container egress was already unrestricted. Until now the agent process itself performed no model-directed network calls: Codex runs at network-off, the Claude sandbox allowlist keeps repository-controlled Bash at effectively no-network, and the only MCP bridge was openfloor's own read-only context tool. A configured MCP server is a direct, single-call channel for session content — prompts, code, the session brief — to reach a host the owner chose. That is a real expansion of what the agent can do, and it is an acceptable one precisely because a session owner explicitly configures each server, members can see the configuration, and the tools are enabled per server. MCP connections are made by the CLI process, outside the Bash sandbox proxy, so the sandbox domain allowlist neither constrains nor needs to include them. If container-level connectivity controls ever land, reopen the egress-proxy question then.

**Consequences:** Undecryptable headers (key rotation) fail the affected run loudly; owners re-enter them. `AgentRunWorkflowEnv` gains `CREDENTIAL_ENCRYPTION_KEY` for dispatch-time decryption; decrypted headers travel only workflow → runner process env → SDK options, never into D1, R2, artifacts, or API responses. The lobby card renders only while `CLAUDE_RUN_ENABLED` is on. Codex runs ignore this table entirely until the parity work lands. `https` is required so header credentials never cross plaintext.

### 2026-08-21 — Session-scoped imported Claude skills, materialized into user scope

**Decision:** Session owners import Claude skills by pasting a `SKILL.md` (`session_skills` table, lobby `SkillsCard`, member-readable summaries). Validation (`lib/skill-validation.ts`) requires frontmatter with a lowercase-slug `name` (`[a-z0-9][a-z0-9-]{0,63}`) and a bounded `description`, bounds the document to 32,000 characters and the session to 20 skills, and re-importing a name replaces it. Claude runs materialize the skills into the container user's `~/.claude/skills/<name>/SKILL.md` during workspace preparation and enable exactly the imported names via the SDK's `skills` option; the target repository's own `CLAUDE.md` is appended to the run prompt as bounded text (first 8,000 bytes). claude.ai skill sync is not built.

**Rationale:** User scope (`settingSources: ["user"]`), never the git worktree — anything written into the worktree becomes a changed path the publisher validates against the expected set, and the `project` source would also load the customer repository's own `.claude/settings.json` and `.mcp.json`, which openfloor does not control; that is also why `CLAUDE.md` arrives as prompt text instead of a settings source. The slug rule makes path traversal unrepresentable rather than filtered. Two SDK behaviors were verified empirically because they are load-bearing: an omitted `skills` option means "CLI defaults", **not** "skills off", so the runner always passes an explicit list (`[]` when none); and the positive `tools` base set excludes the `Skill` tool even when `skills` is set, so the runner adds `"Skill"` to `tools` only when at least one skill exists (verified end-to-end: skill invoked and its instruction followed). A skill's `allowed-tools` frontmatter stays inert — the runner's explicit tool lists are the only tool authority.

**Consequences:** Skills are user-supplied agent instructions with the same trust level as queue prompts — session-scoped, owner-gated, member-visible. The workflow re-checks the slug before writing to the filesystem even though validation already guarantees it. Skill names are read again at the start step, so a skill imported mid-provisioning may be absent from that run — bounded imprecision, same class as the dispatch-time session brief. The lobby card renders only while `CLAUDE_RUN_ENABLED` is on (hide-while-gated convention).

### 2026-08-21 — Add a Claude runner with kernel-sandboxed, non-root execution, behind a disabled rollout gate

**Decision:** `scripts/claude-runner.mjs` runs the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@0.3.239`, default model `claude-opus-5`) inside the same Sandbox image as the Codex runner, selected per run by the new `floor_agents.provider` column (TS-only open enum, default `openai`; nullable `model` overrides the per-provider defaults in `lib/provider-credentials.ts`, which replace the old `AGENT_RUN_MODEL` constant). Model traffic goes through a new `POST /runtime/anthropic/*` gateway (`x-api-key` injected server-side, owner-else-server-else-refuse, path allowlist `messages` + `messages/count_tokens` with rejected paths logged so the list is finalized from observed traffic). The runner executes as the dedicated non-root `openfloor-agent` user under the SDK's own sandbox, configured by `lib/claude-sandbox-settings.ts` in the container user's `~/.claude/settings.json` (`settingSources: ["user"]`) with every value pinned: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `network.allowedDomains: [gateway host]`, `allowManagedDomainsOnly`. The runner additionally pins `permissionMode: "dontAsk"`, explicit `allowedTools`, `disallowedTools: ["WebFetch", "WebSearch"]`, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. Everything is behind `CLAUDE_RUN_ENABLED=false`; no API sets a provider yet.

**Rationale — the isolation posture, stated precisely.** The Step 0 spike established that Cloudflare Sandbox containers are Firecracker microVMs (full capability set, `Seccomp: 0`, user namespaces available), so the Claude runner gets the same two isolation layers as the Codex runner — microVM outside, kernel sandbox (bubblewrap) inside — **but the inner layers are not equivalent and this log does not claim they are**: Codex's inner sandbox has a network on/off flag (`networkAccessEnabled: false`); Claude's is a proxy-enforced domain allowlist, pinned here to the gateway host, which in practice keeps repository-controlled Bash at no-network. The SDK's sandbox cannot initialize as root (its seccomp helper fails writing `uid_map`), which is why Claude runs drop to `openfloor-agent` while the root-side pipeline (git reads, bundle export, checks) is unchanged. The SDK's built-in sandbox settings were chosen over driving `@anthropic-ai/sandbox-runtime` directly: the CLI already decides per-command sandboxing, the settings live in a file only openfloor writes (user scope — a customer repo's `.claude/` is never loaded), and direct wrapping would have had to solve the same gateway-reachability allowlist anyway.

**Rationale — verified, not inferred.** Six behaviors were verified empirically in headless SDK sessions against these exact settings before this shipped, because each is load-bearing and one doc-inferred assumption proved wrong: (1) with `allowUnsandboxedCommands: false`, a `dangerouslyDisableSandbox` retry executes but the parameter is **ignored** — the command stays sandboxed (observed: the retried curl still hit the proxy's 403, never the network); (2) headless permission denials resolve cleanly and never hang — a run continues after a denial; (3) `dontAsk` denial is **per-tool default, not a guarantee**: WebFetch/WebSearch deny, but Bash auto-approves even when absent from `allowedTools` — `allowedTools` is an allow-list, not a restriction; (4) the SDK's positive `tools` option **is** a restriction — `tools: ["Read"]` left only Read available and a Bash request denied cleanly — so the runner pins the base toolset positively (fails closed when an SDK upgrade adds new built-ins) and keeps `disallowedTools: ["WebFetch", "WebSearch"]` as belt-and-braces for the two CLI-process tools that bypass the sandbox proxy; (5) `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips the documented credential set from Bash subprocesses (verified with an AWS decoy scrubbed while a control variable survived), which keeps the run-scoped `ANTHROPIC_AUTH_TOKEN` gateway JWT out of repository-controlled commands; (6) the scrub also reaches MCP children **but leaves their explicit env intact** — `OPENFLOOR_CONTEXT_TOKEN` survives in the `openfloor_session_context` child while an inherited AWS decoy was stripped, so the live session-brief tool is not silently blinded (the failure mode would be an error string the agent quietly works around, not a failed run).

**Consequences:** `RUN_SANDBOX_IMAGE_VERSION` bumped to `v2` (image adds the SDK, bubblewrap/socat/ripgrep, the `openfloor-agent` user, and the runner script). `agent_runs.codex_thread_id` keeps its name and is exposed as `providerThreadId` — see Legacy schema naming. The run-event copy that said "Codex" now says "the agent" on shared paths; event kinds and artifact kinds are unchanged (a Claude run's log persists under the existing `codex_log` artifact kind). The runner captures the SDK's `usage` field into `result.json`; `parseCodexResult` still discards it — API-usage metering remains future work. Three verifications intentionally remain for the flag-enable acceptance, because they need a deployed image and a resolvable Anthropic credential: the composed end-to-end (SDK + bubblewrap inside a real Cloudflare container — Stage B proved the srt layer alone), directly observing `ANTHROPIC_AUTH_TOKEN` scrubbed in-container (local auth doesn't use that variable, so finding 5 verified the mechanism on the documented set rather than that exact variable), and re-confirming in-container that the MCP child still receives `OPENFLOOR_CONTEXT_TOKEN` (finding 6 verified it locally). Auto-dispatch treats a gated provider as a per-item skip, not a session-wide hold — `runRoutingTick` filters Claude-targeted items out while `CLAUDE_RUN_ENABLED` is false (`RoutingDeps.disabledProviders`), because a `disabled` result from the start seam would halt every other provider's items behind one gated item and back off for a condition only an operator can resolve; the seam check remains for manual starts, where `disabled` is the correct answer. Gateway credential resolution adds a D1 read + AES decrypt per model call; measure during rollout before considering any caching. Re-run the four verifications if the SDK pin changes. §4's configurable MCP servers must revisit finding (3): with `dontAsk` auto-approving some tool classes, per-server tool enablement must be enforced with explicit configuration, not permission-mode defaults.

### 2026-08-21 — Run API billing follows the agent owner, not the session owner

**Decision:** Both runtime gateways resolve the per-run provider credential from the run's agent owner (`floor_agents.owner_user_id`, the "Owner" chosen in the create-agent dialog) via `getRunAgentOwnerCredential(runId, provider)`, replacing `getSessionOwnerCredential`. The resolution ladder (owner key, else server key, else refuse; present-but-unreadable refuses) is unchanged — only whose key "owner" means changed. Member removal already transfers the removed member's agents to the removing owner (`removeMember`), so billing follows the transfer; the query's `removed_at IS NULL` guard is defense-in-depth for any path that leaves a removed user owning an agent — such a key is never billed (null result, ladder falls through).

**Rationale:** Decided after the first production Claude acceptance run 503'd exactly as designed: the run creator had connected their Anthropic key, but the session belonged to another user, so the session-owner rule looked for the wrong key. Whoever provisions an agent is the natural payer for its runs — the dialog already makes agent ownership an explicit choice, and per-agent billing lets one session mix agents billed to different members. Plan quota (session hours) still bills the session owner — deliberately separate ledgers; changing that would be its own decision.

**Consequences:** The 503 copy says "agent owner" instead of "session owner". A member can now be billed for an agent someone else queues prompts to — ownership, not initiation, is the billing boundary, consistent with the previous rule's spirit. Worker tests pin the member-owned-agent resolution and the removal-transfers-billing interaction with PR #75.

### 2026-08-22 — Record matched Polar and Midnight website demos from the isolated floor harness

**Decision:** `npm run demo:record` builds the app and records two matched, silent, voiceover-ready Agent Floor videos from one disposable session: Polar uses `polar` and Midnight uses `midnight`. Concurrent contexts keep identifiers, state, timing, and actions aligned. The code-heavy capture builds a realtime incident-response application: Eli owns Forge (Backend engineer), Maya creates Atlas (Frontend engineer) on camera, both have filled team goals, and the Team queue starts empty. Eli and Maya submit separate backend/frontend prompts; test-only stage pacing makes each real run status readable (provisioning, running, checking, ready, publishing, published, integrating, integrated) while auto-dispatch remains real. Team chat, focused activity, logs, the session brief, and Review follow. Review contains ten distinct API, type, persistence, event, UI, style, and test diffs and selects every file. Sign-in, home, lobby, and repository setup stay outside capture. The recorder reuses isolated e2e Worker/D1 and test-only GitHub/run adapters, then exports H.264 MP4s under `artifacts/demo/`.

**Rationale:** A short website walkthrough needs deterministic pacing, exactly matched theme cuts, and no dead time or external side effects. Reusing the existing end-to-end boundary exercises the real session UI and mutations without adding demo state to production modules or depending on a production account, GitHub repository, or paid model call.

**Consequences:** The capture is a staged product walkthrough, not evidence that the recorded run was a live model invocation; narration must not claim otherwise. `docs/website-demo-video.md` owns the shots and voiceover. Successful prompt submission preserves the current queue scope. Agent Floor colors follow visible order, with the first two using the logo's blue and green. The All agents grid derives its columns from available width and wraps before metadata compresses; its tiles have fixed height so status and live-activity updates never shift the floor, and the recorder asserts both stable dimensions and visible metadata through every lifecycle stage. Top-bar candidate branches use an abbreviated leaf label while retaining the full branch in the title, preserving space for the session objective; the redundant browser-history back arrow is absent. The recorder opens the real objective editor to explain that shared goal and its inclusion in synchronized agent context, and asserts the top-bar regions never overlap. The camera returns to the full floor as soon as Eli finishes typing, then Maya composes her frontend prompt concurrently while Forge moves from provisioning through integration. Maya's own lifecycle and Team chat now run together, with a deliberate pause before Eli's reply. `OPENFLOOR_TEST_AGENT_RUN_DATA` now optionally accepts `filesByPrompt`, prompt-specific activity, log text, and a bounded `stageDelayMs`; the delayed path uses real run mutations and floor revisions and remains gated by test identity, so production timing and data are unchanged. Default e2e fixture behavior and speed remain unchanged when those fields are absent. The e2e Wrangler harness binds the existing `SessionRouter`, exercising real auto-dispatch. Deterministic runs persist the same session brief artifact as a production dispatch.

### 2026-08-22 — Add Polar and Midnight as explicit manual product themes

**Decision:** The per-device theme cycle is System → Light → Polar → Dark → Midnight. Polar is a cool near-white surface stack and Midnight is a near-black surface stack; both reuse the contrast-tuned semantic tokens from their Light/Dark base. The pre-paint layout script recognizes all four manual values, and system preference applies only when no manual theme is selected.

**Rationale:** Polar and Midnight are distinct product themes, not marketing aliases for generic Light and Dark. Their token definitions and selector behavior are reused from the existing `UI/reorg` branch so the website recordings and product selector share one authoritative appearance.

**Consequences:** `openfloor:theme` may now contain `polar` or `midnight`; readers must preserve those values rather than resetting them to System. New theme-sensitive colors still belong in `tokens.css`, and the code workbench remains intentionally dark across all themes.

### 2026-08-23 — Move the product off `/app` onto its own subdomain

**Decision:** The app now owns `app.opnflr.com` outright, claimed by a Workers `custom_domain` route, instead of being peeled off `opnflr.com/app` by a path-prefix route. `BASE_PATH` (`components/basePath.ts`) is `""` in every environment. The marketing site's "Open the app" CTA (`openfloor-ai/openfloor.ai`, every page's nav and hero) is now labelled "Sign In" and links straight at `https://app.opnflr.com/home` — a Cloudflare-Access-protected path — instead of the public landing, so the click goes directly to the Access login rather than the animated landing/sign-in interstitial.

**Rationale:** Supersedes the 2026-08-18 "mount under `/app`" decision. A dedicated subdomain removes the query-string wildcard route (`opnflr.com/app*`, which also silently swallowed anything else starting with "app") and the dev/production `BASE_PATH` split that existed only because the production prefix collided with the source `app/` directory during local stylesheet resolution. `custom_domain: true` also has Cloudflare manage the DNS record instead of requiring one to pre-exist.

**Consequences:** `wrangler.jsonc` routes, `OPENFLOOR_RUNTIME_ORIGIN`, the Cloudflare Access application's protected-path list (here, `README.md`, `docs/github-production.md`), the GitHub App's Homepage/Setup/Webhook URLs (`docs/github-production.md`), the Stripe webhook endpoint (`docs/stripe-billing.md`), and the Access branding logo/verification URL (`docs/cloudflare-access-branding.md`) all moved from `opnflr.com/app/...` to `app.opnflr.com/...`. `worker/index.ts`'s asset-serving no longer strips a `/app` prefix. `BASE_PATH` is typed `: string` rather than left to infer the literal `""`, because a bare `export const BASE_PATH = ""` narrows truthiness checks like `BASE_PATH && ...` to `never` at every call site. Tests across `tests/render`, `tests/worker`, `tests/unit`, and `tests/e2e` had their hardcoded `/app` path segments dropped to match. The marketing site's `test.mjs` no longer needs to carve `/app` out of its own route space (`OFF_SITE` removed) since the Worker no longer claims any path on the marketing zone.

### 2026-08-24 — Add Kimi (Moonshot) as a provider by reusing the Claude runner against a second Anthropic-compat gateway

**Decision:** `kimi` joins `CREDENTIAL_PROVIDERS` with default model `kimi-k3` and rollout flag `KIMI_RUN_ENABLED` (false). Kimi runs execute `scripts/claude-runner.mjs` **unchanged** — the workflow's Claude branches now key on `usesClaudeRunner(provider)` and parametrize only the gateway path (`/runtime/${provider}`) and JWT operation. The anthropic and kimi routes share one handler, `lib/anthropic-compat-gateway.ts` (JWT verify bound to the provider's operation → run-status check → 10 MiB cap → path allowlist with log-then-404 under a per-provider prefix → agent-owner-key-else-server-key-else-503 → upstream fetch with SSE passthrough); the abstraction is justified against the copy-first rule because the route is security-sensitive and fixes must not land N times.

**Rationale:** Spike A (2026-08-24, scratch key against `https://api.moonshot.ai/anthropic`): `/v1/messages` accepts both `authorization: Bearer` and `x-api-key` (gateway sends the documented Bearer); SSE framing matches Anthropic exactly (`message_start`/`content_block_delta`/…); `/v1/messages/count_tokens` 404s upstream (kept allowlisted so the CLI degrades on the vendor's answer); `/v1/models` lists bare `kimi-k3` — the Claude-Code-guide alias `kimi-k3[1m]` is NOT an API id (404). An end-to-end claude-runner run against Moonshot completed a real file-creation task with `ok: true`, and the logged traffic contained only `kimi-k3` request bodies plus one harmless `HEAD /api/hello` probe — **no `claude-*` background-model traffic**, so the conditional model-alias runner edit (and its image bump) was provably unnecessary.

**Consequences:** Zero runner changes, zero Dockerfile changes, no image-version bump — pooled sandboxes are untouched. Kimi inherits skills, session MCP servers, the pinned sandbox posture, per-run HOME, and non-root execution because they are runner features. The kimi allowlist starts as the anthropic one and grows only from logged rejections. `MOONSHOT_API_KEY` is the optional server fallback; owner keys bill the agent owner as everywhere else. Flag-flip acceptance follows the per-provider runbook (deploy live → credential resolves → staging full-arc run → gateway log review → flip + decision-log update).

### 2026-08-24 — Exclude Grok (xAI): its Anthropic compat rejects the CLI's system-role messages

**Decision:** Grok ships later or not at all; no `grok` provider id, credential row, flag, or gateway route lands. This supersedes the plan of adding all three providers at once.

**Rationale:** Spike B (2026-08-24, scratch key against `https://api.x.ai`): `/v1/messages` works for simple requests (both auth headers, Anthropic SSE framing, thinking + tool_use blocks); `/v1/messages/count_tokens` 404s; **but the Claude Code CLI's first real request fails with `400 {"code":"invalid-argument","error":"Invalid request content: Invalid message role."}`** — the CLI places `role: "system"` messages (system reminders) inside `messages`, which api.anthropic.com and api.moonshot.ai accept and xAI rejects. Minimal repro confirmed the role is the sole blocker: replaying the CLI's exact captured request with that one role rewritten to `user` returns 200 with correct tool_use. Rewriting roles in our gateway would be a shim on a security-sensitive proxy and was rejected. Recorded for the report: `POST /v1/responses` returns 200 — xAI ships a Responses API, so a codex-runner-shaped Grok (own gateway, `wire_api`-free) is a viable future design if xAI's Messages compat gap persists. *(Tested and refuted 2026-08-24 — see "Grok stays excluded: the Responses path also fails" below.)*

**Consequences:** Revisit when either xAI accepts system-role messages in `/v1/messages` (then Grok is exactly the Kimi recipe: §1 per-provider lines + one ~20-line route + tests) or a codex-runner-based design is chosen. `tests/unit` pins `parseCredentialProvider("grok") === null` so an accidental partial add fails loudly.

### 2026-08-24 — Add a Gemini runner: pinned CLI, system-scope settings, and a fully srt-wrapped posture

**Decision:** `gemini` joins the providers with default model `gemini-3.5-flash`, flag `GEMINI_RUN_ENABLED` (false), and its own runner: `scripts/gemini-runner.mjs` spawns the pinned `@google/gemini-cli@0.56.0` headless (`-p … --output-format stream-json --approval-mode yolo -m <model>`) and maps its events onto the six existing activity kinds (`init`→threadId, `run_shell_command`→command, `write_file`/`replace`/`edit`→file_edit, other tools→tool_call, buffered assistant deltas→agent_message, `result`→usage/finalResponse; SIGTERM→130). Model traffic goes through `POST /runtime/gemini/*` — a standalone route (deliberately NOT the Anthropic-compat helper): run JWT read from `x-goog-api-key` (Bearer fallback), path checked against `^(v1beta|v1)/models/[\w.-]+:(generateContent|streamGenerateContent|countTokens)$`, and the query string forwarded filtered to `alt` (`?alt=sse` is how the CLI streams; the compat handler drops query strings). Posture is **Plan A — the whole runner srt-wrapped**: `runuser -p -u openfloor-agent -- srt -s <run-scoped settings> -c "node /opt/openfloor/gemini-runner.mjs"` with the gateway host as the only allowed domain.

**Rationale (Spike C, 2026-08-24, all empirical against the pinned CLI):** (1) `GOOGLE_GEMINI_BASE_URL` redirection works under fresh HOME + API-key auth — all model traffic hit a local stub as `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` with the key in `x-goog-api-key`; the known base-URL-ignored issue did not reproduce. (2) The env var also flips auth auto-detection to an AuthType (`gateway`) the CLI's validator rejects — hence pinning `security.auth.selectedType: "gemini-api-key"`. (3) Folder trust ON downgrades yolo in an untrusted workspace (breaking headless edits); trust OFF loads the workspace's `.gemini/settings.json` — a boobytrapped workspace MCP server's stdio command **did execute**. The fix is scope precedence, not deletion: the CLI merges user < workspace < SYSTEM, so the pinned posture lives in a SYSTEM-scope file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH` → `RUN_AGENT_HOME/.gemini/system-settings.json`) and `mcp.allowed: ["openfloor"]` name-allowlists servers — with it, the boobytrap was blocked (verified both ways). (4) `-m gemini-3.7-flash` is silently rewritten by the CLI's model-resolution table; `gemini-3.5-flash` is the id that actually reaches the wire, so it is the default (the DB `model` column must record what runs). (5) srt's Linux isolation is `--unshare-net` + env-proxy (HTTP_PROXY→socat→host proxy with domain filtering) — real containment even for uncooperative repo code, but Node 22's fetch ignores proxy env (`NODE_USE_ENV_PROXY` is Node 24+, image ships Node 22) and the CLI overwrites the global dispatcher at startup, so `scripts/gemini-proxy-preload.mjs` wraps `globalThis.fetch` with an explicit `EnvHttpProxyAgent` dispatcher. The composed stack (srt + preload + CLI + real API, allowed domain only) completed a real file-creation run locally; bwrap-in-Firecracker-as-non-root was already proven by the Claude milestone.

**Consequences:** `RUN_SANDBOX_IMAGE_VERSION` bumps to `v3` (image adds the Gemini CLI, sandbox-runtime, undici, and the two new scripts); `CLAUDE_AGENT_HOME` is renamed `RUN_AGENT_HOME` (same path — pooled sandboxes are provider-agnostic and prepare wipes `/tmp/openfloor` every run). Telemetry/usage-stats/auto-update are pinned off; `tools.exclude` kills `web_fetch`/`google_web_search` (deprecated key in 0.56.0, functional in the pin — migrate to the Policy Engine when the pin moves). Session skills and user-configured MCP servers are NOT passed to Gemini v1 (skills are a Claude-runner feature; the Gemini MCP serializer is deferred like the Codex one). The prepare-step context token in the settings file shares the 60-minute TTL. Production acceptance PASSED 2026-08-24 (session 94c775c1, repository Ali-Haroon/TOS-Unravel): one Kimi run and one Gemini run each completed the full arc — dispatch, live activity events, file created, 1/1 checks passed, publish, serialized integration, `providerThreadId` recorded (models on the wire: `kimi-k3`, `gemini-3.5-flash`). The srt-wrapped Gemini CLI + fetch-preload composition worked in a real Cloudflare container first try, closing that residual. The Worker tail during both runs showed only expected gateway traffic (`/runtime/kimi/v1/messages`, `/runtime/gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse`), zero rejected-path warnings, and zero `claude-*` model ids — with the caveat that tail ran in sampling mode, so allowlist growth stays log-driven during normal use. Remaining accepted residual: `run_shell_command` children inheriting the CLI's env including the run-scoped gateway JWT — the CLI has no subprocess-env scrub equivalent to `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, bounded by the JWT's run-status gating, 60-minute TTL, and srt's domain allowlist. Rollback = flip the var back; existing gemini agents degrade correctly.

### 2026-08-24 — Configure production Access as an explicit path allowlist, not protect-everything-then-bypass

**Decision:** The `app.opnflr.com` Cloudflare Access setup is two self-hosted applications sharing one policy ("OpenFloor authenticated users", attached to the second app via "Add existing policy" rather than duplicated), covering exactly the six protected paths from the "Authentication and identity" list above. No bypass application exists for the landing page, static assets, webhooks, or runtime routes — they are simply never listed as an Access destination anywhere.

**Rationale:** The first attempt used the opposite shape: one application with destination `app.opnflr.com/*` (Allow), plus two more applications bypassing specific paths (assets, webhooks/runtime) to carve exceptions back out — an attempt to route around the five-destinations-per-application cap while still expressing "protect everything except these." One of those bypass destinations tried to scope itself to the root path `/` by leaving the Path field blank. In production this bypassed the *entire domain*, including `/home` and `/api/*` — Cloudflare's own app-paths docs confirm a blank Path and a `*` Path are equivalent, and both mean "this hostname plus everything beneath it." There is no distinct syntax for "root only." Switching to an allowlist sidesteps the ambiguity entirely: a path with no matching destination in any Access application receives no Access involvement at all (confirmed via Cloudflare's docs on the separate "Require Access Protection" account setting, which is what would make unmatched paths block instead of pass through — and which must stay off for this design to work).

**Consequences:** Verify with `Zero Trust → Settings → Require Access Protection` off before relying on "unlisted path = public." Adding a new protected page means adding its path to whichever of the two apps has room under the five-destination cap (or a third app sharing the same policy), never a broad wildcard destination. Do not reintroduce a `app.opnflr.com/*`-style catch-all application, even paired with bypass apps for the public paths — the blank/`*`-Path ambiguity makes that shape fragile in exactly the way that happened here. `README.md`, `docs/github-production.md`, and `docs/cloudflare-access-branding.md` all describe the two-application topology now.

### 2026-08-24 — Fix the post-logout sign-in dead end: hide the wildcard app's launcher tile, trust both AUDs, own sign-out

**Decision:** Three changes address a reported bug where signing back in after sign-out could land a user on the unroutable `https://app.opnflr.com/api/*`. (1) App 2's (`app.opnflr.com/api/*`) **Experience settings → "Show application in App Launcher"** turned off in the dashboard. (2) `lib/identity.ts`'s `cloudflareAccessIdentity` now parses `CF_ACCESS_AUD` as a comma-separated list (`parseAudienceList`) and passes the array to `jose`'s `audience` option, so it trusts a JWT minted for either app's AUD tag rather than depending on undocumented cookie/`aud`-merge behavior across the two apps. (3) Sign-out moved from a direct `/cdn-cgi/access/logout` link to an app-owned `app/signout/route.ts`, which clears the app-domain `CF_Authorization` cookie itself and redirects to the team-domain logout (`https://<team>/cdn-cgi/access/logout`) to end the global Access session. `worker/index.ts` also gained a narrow defense-in-depth: a `404` on a `GET /api/*` carrying `sec-fetch-mode: navigate` redirects to `/home` instead of rendering "Not Found".

**Rationale:** Cloudflare's App Launcher launches "the application's hostname" — the single domain configured on the app — so a wildcard-path-only app's tile is that literal, unroutable string, and Cloudflare gives a separate tile per app sharing one hostname. A signed-out user re-entering through `openfloor.cloudflareaccess.com` therefore had a real chance of landing on the dead tile; hiding it is the actual fix. The AUD list is defense against a second, previously silent assumption: nothing in Cloudflare's docs states whether one hostname's `CF_Authorization` cookie merges multiple apps' AUD tags into a single token's `aud` array (confirmed absent from `developers.cloudflare.com` during this investigation) — trusting either tag explicitly removes the dependency regardless of the true behavior. Neither Access logout endpoint accepts a `returnTo`, and the app-domain one alone left the team-domain global session alive, which is what made re-sign-in silently re-authenticate the same Google identity with no prompt — a single owned route that hits both cookie scopes closes that gap. The `worker/index.ts` redirect is a last-resort safety net for the same failure class recurring (a dashboard misconfiguration pointing a browser at a route nothing serves); it keys on `sec-fetch-mode: navigate` specifically because an earlier attempt using an `Accept: text/html` fallback redirected genuine member-only `404`s in `tests/render/skills.test.ts` and `tests/render/mcp-servers.test.ts`, whose test helpers reuse that header on real API calls.

**Consequences:** `CF_ACCESS_AUD` must be set to both apps' AUD tags, comma-separated, in Worker secrets — a single tag still works unchanged. `cloudflare-env.d.ts` gained `CF_ACCESS_TEAM_DOMAIN?: string` on `Cloudflare.Env` so `app/signout/route.ts` can read it via `cloudflare:workers`'s `env`. Any future sign-out UI must link to `/signout`, never `/cdn-cgi/access/logout` directly. `/signout` must never be added to either Access application's destinations. The App Launcher visibility toggle and Cookie Path Attribute setting are dashboard state outside version control — re-verify them if the two Access applications are ever recreated.

### 2026-08-24 — Credential kinds become first-class: two rows per provider, selected per agent

**Decision:** `user_provider_credentials` is keyed `(user_id, provider, kind)` (migration `0025`, this table's one recreate — SQLite cannot widen a primary key in place; the drizzle `__new_` swap copies rows verbatim and nothing references the table). `kind` is `api_key` or `oauth`: an `oauth` row stores a subscription credential the member minted themselves and pasted — the `claude setup-token` output for `anthropic`, a `~/.codex/auth.json` bundle for `openai` — encrypted like every credential, fingerprinted by token last-four or ChatGPT `account_id`, stored with `validated_at = null` because no free validation probe exists. `credentialKindsForProvider` allows `oauth` only for `anthropic`/`openai`, enforced at the PUT route and again at gateway resolution. `floor_agents.credential_kind` (nullable, no default, plain `ALTER TABLE ADD`) says which kind an agent's runs bill; the create-agent dialog offers Owner's default / Subscription / API key only when the provider has both kinds, and deliberately does not reveal which kinds the chosen owner has connected. Every gateway resolves through one shared ladder, `resolveRunProviderSecret` (`db/provider-credentials.ts`), which wraps the pure `resolveRunCredentialSource`: owner credential of the named kind, else server key, else refuse — and three cases refuse outright rather than switching payer: an unreadable owner credential, an agent-named kind the owner has not connected (`missing_selected_kind`, surfaced as "This agent is set to use your <vendor> subscription/API key, which is not connected…"), and a hand-written row of a kind the provider does not allow. AAD stays the bare legacy `<userId>:<provider>` for `api_key` rows and binds `<userId>:<provider>:<kind>` for new kinds, so nobody reconnects. Server fallback credentials are `api_key` by construction.

**Rationale:** A subscription is rate-limited by design; several agents on one seat will hit its window, and without a per-agent escape hatch those runs die on 429 with nothing the member can do. Per-agent selection (rather than either/or per user) gives the member both ledgers side by side. Automatic failover between a member's own two credentials was considered and rejected — it switches ledgers mid-run, exactly what the "never silently switch payer" invariant forbids. The Spike C capture (2026-08-24) informed the storage design: an oauth-mode Agent SDK request differs from the Bearer/API-token mode **only in transport headers** (the bearer value plus the `anthropic-beta` flags `oauth-2025-04-20` and the incidental `extended-cache-ttl-2025-04-11`), never in body or system prompt, so kinds are a credential-storage-and-gateway-header concern, not a runner concern. These are paste-a-credential flows Anthropic and OpenAI document for CI use, not an openfloor-operated OAuth login (still out of scope).

**Consequences:** Gateways do not yet send `oauth` credentials in their native header shape — that is §4 of the standing brief (`docs/glm-grok-subscription-provider-prompt.md`), gated on a live setup token re-run of Spike C — so a subscription-bound agent today fails honestly at the vendor with an auth error rather than silently billing something else; the Settings copy says the row is "not yet verified". `DELETE /api/account/credentials/[provider]` takes `?kind=` (default `api_key`). The `users`-adjacent AAD invariant tightens: future migrations touching credential rows must preserve user id, provider, AND kind. Worker tests pin the two-agents-two-kinds resolution, the null-kind default, the missing-named-kind refusal (with a server key present — the assertion that stops a disconnected subscription from billing openfloor), and the wrong-kind-for-provider refusal. Out of scope, recorded in `docs/agent-backend-gaps.md`: more than one row per kind (nickname + picker later, not another recreate), automatic failover between kinds, and any subscription-quota display.

### 2026-08-24 — Grok stays excluded: the Responses path also fails, on replayed reasoning items

**Decision:** Grok (xAI) still does not ship. The Responses-API design the previous Grok entry named as viable was spiked against a scratch key with the real pinned `@openai/codex-sdk@0.148.0` driving a logging proxy into `https://api.x.ai/v1`, and it fails on the second model request of every thread. No `grok` provider id, credential row, flag, or gateway route lands; `tests/unit` keeps pinning `parseCredentialProvider("grok") === null`.

**Rationale (Spike B, 2026-08-24, all empirical):** Turn one succeeds — after removing Codex's multi-agent `namespace` tool via the SDK's documented `features.collab=false` config override (xAI's deserializer rejects `tools[].type: "namespace"` with 422; the override is runner-side configuration, not a gateway rewrite), `POST /v1/responses` returned 200 with working SSE, and grok-4.5 completed a real file-creating command. But Codex is fully stateless (`store:false`, `include:["reasoning.encrypted_content"]`, `previous_response_id` never sent — full-history replay every request), and the continuation request that replays the prior turn's reasoning item always got 400 `{"code":"invalid-argument","error":"Could not decode the compaction blob. Ensure it is unmodified from the compact response."}`. Root cause was isolated to one byte-level field with direct probes: xAI's own reasoning item replayed byte-exact returns 200; replayed in Codex 0.148.0's serialization — which adds an explicit `"content": null` to reasoning input items — returns the 400; dropping `status` alone or mutating summary text still returns 200. So the single fatal field is Codex's `"content": null`, which xAI's deserializer treats as blob corruption. Rewriting request bodies in the gateway is the standing rejected shim, in the same costume as the role-rewrite that killed the Anthropic-compat route.

**Consequences:** Revisit when either xAI tolerates `content: null` on replayed reasoning input items or a Codex pin stops emitting it — then Grok is a Responses-gateway recipe (extract `lib/responses-gateway.ts` from the OpenAI route, add a ~20-line grok route with `XAI_API_KEY`, flag `GROK_RUN_ENABLED`). Facts worth keeping for that day, from the same spike: model list includes `grok-4.5` (aliases `grok-4.5-latest`/`grok-build-latest` — the current coding pointer) and `grok-build-0.1` (alias `grok-code-fast-1`); the CLI is WebSocket-first (five `ws://…/responses` upgrade attempts, ~7s, before an automatic HTTPS fallback a POST-only gateway will always incur); the only path called is `/responses`; and the CLI sends `originator`, `session-id`, `thread-id`, `version`, `x-client-request-id`, `x-codex-beta-features`, `x-codex-turn-metadata`, `x-codex-window-id` headers the current OpenAI route does not forward (and never sent `openai-beta` over HTTP in these runs).

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

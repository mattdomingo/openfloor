# openfloor Engineering Guide

This file is the authoritative repository-level guide for engineers and coding agents working on openfloor. It applies to the entire repository unless a more specific `AGENTS.md` is added in a subdirectory.

Last verified against `main`: 2026-08-26.

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
3. Deploy to the active production environment when its browser acceptance flow depends on GitHub, Cloudflare runtime resources, or OpenAI, unless the user establishes a separate staging environment.
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

1. **D1-authoritative application state**: users, Stripe entitlement projections, sessions, memberships, invites, objective, routing settings, agents, assignments, messages, queue items, queue prompts, ordering, agent-run rollback groups/attempts, merge-conflict cases/attempts/questions, and floor revision. Stripe remains authoritative for the external subscription lifecycle; D1 owns the product-facing projection.
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
- Non-members receive the same not-found response as nonexistent sessions. This concealment prevents metadata enumeration.

### Missing capabilities stay absent

Nullable and empty fields are a deliberate contract, not a temporary rendering bug. UI code must handle absence without inventing defaults. When a future backend is connected, it should provide authoritative data through typed interfaces and explicit mutations.

### Collaboration should survive reloads

Anything presented as durable collaboration must be stored in D1 and returned by the authoritative snapshot. A successful mutation returns the updated snapshot, increments `floor_revision` when it changes floor state, and notifies other clients to refetch.

### Realtime is a coordination signal, not a second database

WebSocket events notify clients about presence or changed domains. D1 remains authoritative for persisted floor data. Except for ephemeral typing drafts, do not turn the Durable Object into a shadow copy of floor records.

## Current product boundary

### Implemented and real

- Cloudflare Access authentication using GitHub or One-time PIN as configured by the production Access application (GitHub primary since 2026-08-27; Google removed from the apps' identity providers).
- Server-only loopback development identity from `.dev.vars`.
- Internal user records keyed by the stable external provider subject.
- Explicit first-login Free/Pro/Max selection for direct signups; valid signed-invite signups receive Free automatically, while Enterprise remains sales-managed.
- Stripe Checkout for monthly Pro/Max subscriptions, exact purchased seat quantities, Customer Portal management and prorated plan changes, signed replay-safe entitlement webhooks, and immediate no-refund cancellation during account deletion.
- Session creation, listing, objective editing, membership, roles, and leaving.
- Owner-only session ending: `ended_at` marks the session read-only for everyone, revokes the active invite, and broadcasts `session.ended`; ended sessions stay readable and members can still leave.
- Owner-only session deletion (immediate and cascading for repository-free sessions) and a daily cron that purges repository-free sessions ended more than 30 days ago. Sessions with repository state fail closed until durable external cleanup exists. The home screen groups Active and Ended sessions.
- HMAC-signed, reusable owner invitations with rotation and revocation.
- Session lobby with real roster and live online status.
- Account-level GitHub App setup: every direct or invite signup completes two-step onboarding — Profile & GitHub together, then optional AI Connections — and is enrolled on the Free plan automatically (the plan step is hidden for now; see the 2026-08-27 decision). Active personal/organization installations are reusable across future session creation and Settings supports multiple installations. No GitHub OAuth or user token is stored.
- Session creation requires an account-authorized repository, verifies its default-branch head before D1 creation, atomically reserves the session/invite/repository/candidate, and provisions the candidate before routing the owner in. A ready provision lands straight on the agent floor; a post-reservation remote failure instead lands on the lobby with `?repo=required`, recoverable from there. `HomeScreen.tsx`'s `CreateSessionDialog` (opened from `/home`'s New session tile) is a single-page creation dialog — task/goal, repository + owner-named candidate branch, and an optional AI connection all on one screen — collecting everything before `POST /api/sessions` fires once; there is no post-creation setup dialog.
- Protected Agent Floor with real session title, objective, members, and presence.
- Persistent agent records created from required user input.
- Persistent member assignments.
- Persistent team messages and private direct messages.
- Persistent assigned or unassigned queue prompts.
- Manual queue ordering and same-target queue merging with prompt authorship preserved. The queue panel groups items client-side into six fixed sections (`groupQueueItems` in `components/session/data.ts`): Live first in dispatch order (`position` ascending — queued/running/blocked/paused items, active runs, parked ready/published, mid-rollback, and discarded runs), then collapsible Conflicted (default expanded), Failed, Answered, Integrated, and Cancelled bars, each newest-first by `createdAt`. Grouping is presentation-only: D1 order and `position` semantics are unchanged, and drag reorder applies only inside Live.
- Realtime floor revision notifications and snapshot refetching.
- Ephemeral realtime teammate prompt drafts with Everyone, Typing, and Hidden viewing modes.
- Movable, resizable, collapsible, expandable panels and responsive floor layout.
- Review navigation backed by genuine local agent-run files, diff previews, and checks when a run exists; otherwise it keeps an authoritative empty state.
- Read-only whole-repository browsing inside Review: any session member can page through the connected repository's file tree and open any file, not only ones a run changed, at the active candidate's head SHA (or the connection's base branch before a candidate exists). Changed files still show their diff and attribution; other files show plain content. Bounded to 10,000 tree entries and 512 KB / 5,000 lines per file, with no branch switching and no write path.
- One GitHub repository connection per session, selected by the owner from opaque account-installation repository options. Legacy incomplete sessions use the same account-authorized selection path.
- Durable GitHub installation/repository identifiers and selected base branch.
- Member-visible repository details with owner-only connect, configure, disconnect, and reconnect controls.
- A public GitHub webhook boundary that caps payloads and verifies the raw-body HMAC before acknowledging them.
- One durable active repository candidate per session, created at the selected repository's verified default-branch SHA using session title/objective metadata on a server-generated `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>` branch.
- Owner-only repository synchronization with connected, ready, revoked, inaccessible, externally modified, and behind-base presentation.
- Idempotent GitHub installation, repository-access, rename, push, pull-request, check, and status delivery processing keyed by delivery ID.
- Owner-started repository preflight through a durable Cloudflare Workflow and an isolated Cloudflare Sandbox at the exact candidate SHA.
- Ordered required-check results in D1 with bounded command logs in private R2 and reload-safe provisioning, running, passed, failed, and timed-out UI states.
- Owner-started and owner-cancelled queue execution through a durable `AgentRunWorkflow`, with one active run per queue item.
- Server-side Codex SDK execution using `gpt-5.6-terra` in an isolated Sandbox at the exact candidate SHA, with workspace-write permission and no repository network access.
- A unified session brief injected as every dispatched agent's prompt (`db/session-context.ts` + `lib/session-context.ts`, assembled at workflow dispatch): the agent's own request and prior attempts, every other agent and human assignment on the floor, already-integrated run summaries and files, other runs currently in flight with compacted file activity, the rest of the queue, blocked/failed runs, and relevant team-chat messages (prioritizing `@mentions` of the agent, capped to 6 messages). The read is session-scoped with no `userId` parameter, so direct messages are structurally excluded rather than filtered — the query itself only ever selects `recipient_user_id IS NULL`. The brief is a snapshot at dispatch time, bounded to 6,000 characters with honest empty-section text and explicit truncation counts; it never fabricates floor state.
- A live re-read of that same brief for long runs: the Sandbox exposes a read-only `openfloor_session_context` MCP tool (`scripts/openfloor-mcp.mjs`, wired into the Codex SDK's `config.mcp_servers`) backed by `GET /runtime/run/context`. Tool calls surface in the activity timeline as a `tool_call` event. Pooled run sandboxes are keyed by `RUN_SANDBOX_IMAGE_VERSION` (`worker/agent-run-workflow.ts`) so a stale pooled container from before an image change is never claimed by a live run.
- The exact prompt a run received is persisted as an `agent_run_artifacts` row of kind `prompt` and visible to members through a second Agent-card expander, alongside the existing raw-log expander (whose own default output is unchanged).
- An owner-only nudge when public team chat has moved past the objective: `sessions.objective_updated_at` (distinct from `updated_at`, which every floor mutation touches) tracks only objective saves; once `OBJECTIVE_NUDGE_THRESHOLD` public messages postdate it, `ObjectiveBar` shows a banner that opens the existing inline editor. No new mutation; purely derived from data already in `FloorSnapshot`.
- Durable run, event, check, changed-file, and artifact metadata; bounded complete logs and diffs live in private R2.
- Real run status and file/check data in Agent cards and Review. Each passing run is automatically preserved on its own verified `openfloor/<session-short>/run/<run-short>` GitHub branch; consecutive prompts retain separate branches and audit history.
- Trusted incremental Git-bundle validation and non-force publication from a clean publisher Sandbox, followed by GitHub SHA reconciliation.
- Owner-only safe discard using an expected-SHA lease; externally modified run branches are never deleted.
- Serialized candidate integration inside `AgentRunWorkflow`, with a D1 candidate lease, authoritative GitHub ref reconciliation, non-force merge, one draft PR, queue completion, and durable detection of a real GitHub integration `409`.
- Review by Files or Prompts with candidate-wide prompt, engineer, and software-agent attribution. Changed files show contribution cards; Prompts pages Active/History groups and exact historical run diffs. The session owner, the run's agent owner, or the engineer who authored every prompt in one integrated group may remove that group; the owner may atomically remove every active solely-authored group for an engineer or every active group produced by an agent. Mixed-author engineer groups are explicit exclusions. Every action previews and revalidates the exact candidate SHA/run set, runs required checks, reconstructs one newest-first deterministic inverse commit in a separate trusted publisher Sandbox, and expected-SHA pushes it. Run/prompt/branch/rollback history stays immutable; successful groups leave active attribution and future agent briefs but remain in Review History and Queue as Rolled back.
- Automatic merge-conflict resolution as specialized system runs attached to the original queue item, never fabricated floor agents. `sessions.auto_resolve_conflicts` defaults on independently from ordinary `auto_dispatch`; eligible cases run ahead of new queue work while respecting capacity, quota, repository, provider, and inherited-agent gates. A resolver inherits the source agent/provider/model and agent-owner credential policy, reconstructs a genuine three-way merge from exact archives plus the retained verified bundle, runs configured checks, and publishes through the existing trusted pipeline.
- Durable conflict input and retry workflow: the resolver may request one to three bounded questions through the run-only `openfloor_request_conflict_input` MCP tool and stop without publishing; any current member may answer the exact current set, while only the owner may manually start/retry. Two automatic attempts are allowed since the last human answer. Reload-safe Queue/Review attention UI, a floor banner, navigation badge, and opt-in per-device hidden-tab browser alerts expose cases needing people.
- Manual per-hunk resolution as a deterministic fallback when the automatic resolver stops on `failed` or `awaiting_input`: every resolver attempt (automatic or manual) captures a `conflict_snapshot` run artifact — bounded raw base/ours/theirs/merged bodies for up to 40 conflicted paths — right after its three-way merge, so a human decision is available the moment automation stops rather than needing a fresh sandbox. The session owner or an original prompt author (same rule as free-text answers) opens the conflict center's manual step from Review's attention-lit Conflicts popup, sees every real conflict hunk (`lib/conflict-hunks.ts` parses the standard `<<<<<<<`/`=======`/`>>>>>>>` markers; a whole-file delete/modify, modify/delete, or binary conflict gets one synthetic hunk instead), and chooses ours/theirs/both per hunk or bulk-applies one choice to a whole file. Submitting resumes the case for a `manual`-launch-kind resolver attempt whose workflow applies the exact recorded choices by rewriting marker blocks directly — no model call, no tokens — then runs through the same marker-removal verification, checks, and publish/integrate pipeline as every other attempt. A selection set applies only when it still covers every hunk in that attempt's own fresh merge; any mismatch (the candidate moved, a path the snapshot couldn't reach) falls back to running the resolver agent normally rather than guessing. No `floor_agents` row is created for this either — the source agent's own floor card instead turns red while its case is open (amber and breathing when a person must act) and clicking it opens this exact case in Review.
- GitHub-authoritative final review snapshots with bounded PR files, check runs, commit statuses, head/base SHAs, draft state, mergeability, and merge-requirement state.
- Owner-only **Ready for review** and expected-head **Squash merge** actions, each behind a confirmation dialog. A ready pull request can be converted back to a draft (**Mark as not ready**, also confirmed) through GitHub's `convertPullRequestToDraft` mutation; the first-ready audit (`review_ready_at`/`review_ready_by`) is kept rather than cleared. GitHub protection and review requirements are never bypassed.
- Verified post-merge cleanup of matching server-generated run/candidate refs using Git leases; mismatched refs are preserved and recorded as partial cleanup.
- Merged candidate audit history remains durable, while the next owner-started run creates a fresh candidate cycle from the latest base SHA.
- Per-user provider credentials (`user_provider_credentials`, providers `anthropic`/`openai`/`kimi`/`gemini`/`glm`/`qwen`/`deepseek`), now keyed `(user_id, provider, kind)` with two first-class kinds: `api_key` (validated against the provider's models endpoint on connect — `lib/provider-validation.ts` holds the per-provider URL + auth-header record) and `oauth` (a pasted subscription credential — Claude `setup-token`, a Kimi Code plan key, or ChatGPT `auth.json`. A Claude setup token validates on connect exactly like a key — `GET /v1/models` with a plain Bearer authenticates it, Spike C rerun — and stores a real `validated_at`; a ChatGPT bundle and a Kimi Code plan key have no connect-time probe and store `validated_at = null`, "Connected — not yet verified", never a faked timestamp — for Kimi deliberately, because the plan surface is vendor-documented but unverified with a live plan key and a wrong probe would block every connect). `credentialKindsForProvider` allows `oauth` for `anthropic`, `kimi`, and `openai` — enforced at the PUT route and again at gateway resolution. A ChatGPT `auth.json` bundle drives real Codex runs since Spike D passed (2026-08-26): the openai gateway sends **only** the bundle's `tokens.access_token` plus a gateway-injected `chatgpt-account-id` to `https://chatgpt.com/backend-api/codex/responses`, while an `api_key` resolution keeps going to `https://api.openai.com/v1/responses`. The run container never receives the bundle at all, and openfloor refreshes it server-side under a conditional D1 update (see the 2026-08-26 ENG-117 decision entry). All rows are AES-256-GCM-encrypted at rest under `CREDENTIAL_ENCRYPTION_KEY` (AAD: bare legacy `<userId>:<provider>` for `api_key`, `<userId>:<provider>:<kind>` for newer kinds — existing rows never need reconnecting) and write-only from the client (routes return only a last-four fingerprint — the token's for keys and setup tokens, the ChatGPT `account_id`'s for bundles). Per run, every runtime gateway resolves through the one shared ladder (`resolveRunProviderSecret`, `db/provider-credentials.ts`): the **agent owner's** connected credential of the kind the agent names (`floor_agents.credential_kind`; null = api_key else the single existing row), else the server key (always `api_key` by construction — openfloor never operates a subscription seat as a fallback), else refuses with a clear `503`. A present-but-unreadable owner credential, an agent-named kind the owner has not connected, and a hand-written row of a kind the provider does not allow all refuse rather than silently switching payer. The anthropic gateway sends each kind in its native auth form: `x-api-key` for `api_key` rows and the server key, `authorization: Bearer` plus a merged `anthropic-beta: oauth-2025-04-20` for a subscription setup token (merged after the client's own flags, never overwriting them; the incidental `extended-cache-ttl-2025-04-11` is deliberately not sent). The compat gateways also forward `retry-after` and the whole `anthropic-ratelimit-*` family to the run — the `unified-*` headers are the only utilization signal a subscription-billed run gets.
- Session-configured remote MCP servers (`session_mcp_servers`, v1 `http`/`sse` only, `stdio` deferred): the owner adds up to 10 per session in the lobby (name, transport, https URL, optional headers, enabled flag); members read summaries. Header values follow the credential at-rest rules — encrypted, write-only, reads expose header names only. `openfloor` is a reserved name, and the built-in `openfloor_session_context` server is always present and not user-removable. Enabled servers reach Claude runs in the SDK's `mcpServers` shape with their tools allow-listed per server (`mcp__<name>`), never via a blanket permission mode. Connections go directly from the run container to the configured host.
- Session-scoped imported Claude skills (`session_skills`): the owner pastes a validated `SKILL.md` in the session lobby (members read the list), bounded to 32,000 characters and 20 per session, with the name constrained to a filesystem-safe slug. Claude runs materialize them into the container user's `~/.claude/skills/` (never the git worktree) and enable exactly the imported names via the SDK's `skills` option; a skill's `allowed-tools` frontmatter cannot widen the run's toolset. The target repository's own `CLAUDE.md` is appended to the run prompt as bounded text (first 8,000 bytes) rather than loaded as a settings source. claude.ai skill sync is not implemented.
- A Claude agent runner (`scripts/claude-runner.mjs`, Claude Agent SDK, default model `claude-opus-5`) structurally parallel to the Codex runner, gated behind `CLAUDE_RUN_ENABLED` (currently on). `floor_agents.provider` (default `openai`) and nullable `model` choose the runner per run; `AgentRunWorkflow` branches at dispatch on `usesClaudeRunner(provider)` (`lib/provider-credentials.ts`). Claude runs execute as the non-root `openfloor-agent` user under the SDK's kernel sandbox (bubblewrap + proxy-enforced domain allowlist), with the pinned posture in `lib/claude-sandbox-settings.ts` and model traffic through `POST /runtime/anthropic/*` — see the 2026-08-21 Claude-runner decision-log entry for the verified isolation semantics.
- A Kimi (Moonshot) provider that reuses `scripts/claude-runner.mjs` unchanged — Moonshot's documented Anthropic-compat endpoint means only the gateway differs. Gated by `KIMI_RUN_ENABLED` (currently on); default model `kimi-k3`; model traffic through `POST /runtime/kimi/*` (`lib/anthropic-compat-gateway.ts`, the shared handler the anthropic route also uses; upstream `https://api.moonshot.ai/anthropic/v1`, Bearer auth per Spike A). A Kimi Code subscription (plan) key connects as the `oauth` kind and is served from the plan's own upstream — `https://api.kimi.com/coding/v1`, key sent as `x-api-key`, the compat handler's `oauthUpstreamBase` — on the vendor's documented-but-not-purchase-verified surface (2026-08-26 decision-log entry; the plan waitlist blocked a spike account, so production members' plan runs are the acceptance). Runner features (skills, MCP servers, sandbox posture, per-run HOME, non-root user) are inherited because they are runner properties, not model properties — see the 2026-08-24 Kimi decision-log entry.
- A GLM (Z.ai) provider that reuses `scripts/claude-runner.mjs` unchanged — Z.ai's documented Anthropic-compat endpoint is the officially supported path for Claude Code-shaped tools, so only the gateway differs (the Kimi recipe, verbatim). Gated by `GLM_RUN_ENABLED` (currently false); default model `glm-5.3` (the id Z.ai's models endpoint returns — marketing names are not API ids); model traffic through `POST /runtime/glm/*` (`lib/anthropic-compat-gateway.ts`; upstream `https://api.z.ai/api/anthropic/v1`, Bearer auth per Spike A). Z.ai's `count_tokens` is a real 200, unlike Moonshot's 404; glm-5.3 always thinks (bare requests 400), but the CLI's native `thinking: adaptive` is accepted, so the runner needs nothing. Runner features (skills, MCP servers, sandbox posture, per-run HOME, non-root user) are inherited because they are runner properties — see the 2026-08-24 GLM decision-log entry.
- A Gemini agent runner (`scripts/gemini-runner.mjs`, spawning the pinned `@google/gemini-cli@0.56.0` in headless stream-json mode) gated by `GEMINI_RUN_ENABLED` (currently on); default model `gemini-3.5-flash`. Gemini runs execute as `openfloor-agent` with the ENTIRE runner srt-wrapped (`@anthropic-ai/sandbox-runtime@0.0.73`, gateway host the only allowed domain — the CLI has no built-in sandbox, unlike the Agent SDK), the CLI's fetch made proxy-aware by `scripts/gemini-proxy-preload.mjs`, and the pinned CLI posture in a SYSTEM-scope settings file (`lib/gemini-settings.ts`) that beats the target repository's own `.gemini/settings.json` in the CLI's merge order. Model traffic through `POST /runtime/gemini/*` (path pattern + filtered `alt` query, run JWT in `x-goog-api-key`). No skills and no CLAUDE.md append — the CLI natively reads the repository's GEMINI.md. See the 2026-08-24 Gemini decision-log entry for the verified posture.
- A Qwen Code agent runner (`scripts/qwen-runner.mjs`, spawning the pinned `@qwen-code/qwen-code@0.22.3` in headless stream-json mode) serving TWO providers — `qwen` (Alibaba Cloud Model Studio, default model `qwen3-coder-plus`, gated by `QWEN_RUN_ENABLED`, currently false) and `deepseek` (default `deepseek-v4-pro`, gated by `DEEPSEEK_RUN_ENABLED`, currently false) — because the CLI speaks OpenAI chat completions and both vendors serve that wire; `usesQwenRunner(provider)` (`lib/provider-credentials.ts`) is the predicate every workflow branch keys on, and the gateway route the run JWT is bound to (`/runtime/qwen` vs `/runtime/deepseek`) is the whole per-provider difference (the Kimi→GLM recipe). Runs execute as `openfloor-agent` with the ENTIRE runner srt-wrapped exactly like Gemini (same `buildGeminiSrtSettings` posture, reused not copied; no fetch preload — the CLI honors srt's proxy env natively), the CLI reading only the run JWT in `OPENAI_API_KEY` and the gateway in `OPENAI_BASE_URL`, and the pinned posture in a SYSTEM-scope settings file (`lib/qwen-settings.ts`, `QWEN_CODE_SYSTEM_SETTINGS_PATH`) that beats the target repository's own `.qwen/settings.json`: auth type pinned to `openai`, folder trust off, usage statistics/auto-update/telemetry off, the CLI's managed-memory subagent off (it otherwise makes a second model call after every turn), `web_fetch`/`web_search` denied, hooks disabled, MCP name-allowlisted to `openfloor`, and `tools.toolSearch` off so the `openfloor_session_context` bridge actually reaches the model. The runner's stream-json vocabulary is Claude-Code-shaped (`system/init`, `assistant` content blocks, `user` tool results, `result`), not gemini-cli's, so it has its own normalizer; an upstream API error arrives as assistant text `[API Error: …]` under a `success` result and is mapped to a failed run. No skills and no CLAUDE.md append — the CLI natively reads the repository's `QWEN.md`. Model ids are doc-banked pending Spikes Q2/D1 (a live key per vendor); flags stay false until each vendor's flag-flip runbook passes. See the 2026-08-28 Qwen/DeepSeek decision-log entries and `docs/qwen-deepseek-provider-prompt.md` (Spike Q1 report).
- Prompt-intent routing and agent replies: `db/routing.ts`'s router classifies every queued item as `task`/`question`/`noise` (`floor_queue_items.intent`) before assignment. Each untargeted `question`/`noise` item receives its own idle/reused built-in answer agent (`floor_agents.kind = 'answer'`, `db/floor.ts`'s `ensureAnswerAgent`) while another Concierge is claimed or busy; a targeted item keeps its named agent but still runs as a reply. Either way, dispatch starts a read-only `agent_runs.kind = 'reply'` run (see the `agent_runs` invariant above) instead of an ordinary task run. `agent_runs.status` itself gains no new value — `components/session/data.ts` maps `kind: "reply"` + `status: "ready"` to the presentation-only `"answered"` token. Answered queue items render in the queue's collapsible Answered section (between Failed and Integrated), with their status chip left-aligned. `AgentCard` renders `final_response` through a small absolutely-positioned response icon that consumes no grid space; hover or keyboard focus opens a wrapped viewport-clamped tooltip, and activation opens the focused spotlight containing the full response. See the 2026-08-25 decision-log entries.
- Owner-controlled generated-agent lifecycle: `sessions.auto_provision_agents` works only with `auto_dispatch`. Routing assigns idle persistent agents first, then activates reusable system-managed `floor_agents.kind = 'worker'` rows for remaining tasks. Generated workers and `kind = 'answer'` Concierge are owner-owned, visibly marked **Auto-generated**, hidden while `deprovisioned_at` is set, and never deleted. Multiple concurrent questions receive distinct Concierge rows within the existing session/global run limits; successful replies complete their queue items and the next routing tick retires each idle Concierge for reuse. New sessions default provisioning on; migration `0028_great_sinister_six.sql` backfills existing sessions off. Automated scheduling counts all nonterminal execution/publication/integration work and is capped at 15 runs per session and 30 globally. See the 2026-08-25 generated-agent decision-log entry.
- Per-agent model selection at creation: the create dialog's Model field picks from the closed per-provider allowlist `PROVIDER_MODELS` (`lib/provider-credentials.ts`; first entry = the provider default, "Provider default"/null keeps today's behavior), re-keyed off the Provider field so an id can never post to another vendor; `parseAgentInput` enforces the same list server-side. The dialog's `provider` state initializes from `enabledProviders[0]` so a single-enabled-provider deployment cannot strand the hardcoded `"openai"` initial value behind the conditionally-rendered Provider select.
- Post-creation agent settings editing: the spotlight carries Model and (for multi-kind providers) Billing `SelectMenu` rows beside the task editor, same `kind IS NULL` gate, applying on change through the existing agent PATCH (`updateFloorAgentSettings`, `db/floor.ts` — the generalized `updateFloorAgentTask`). `model`/`credentialKind` validate against the agent's stored provider (immutable for persistent agents — the only provider-touching UPDATE is the generated-agent reuse path, unreachable behind `kind IS NULL`); a billing change is refused `409` while the agent has a run in `AGENT_ACTIVE_RUN_STATUSES` because the gateway resolves the payer live on every proxied request — the mid-run payer-switch refusal is worker-test-pinned.
- Provider thread resume across attempts (`lib/run-resume.ts`): a retry or re-run of the same queue item — or a system-originated follow-up naming its `floor_queue_items.source_run_id` — continues the earlier attempt's Codex thread / Claude session / Qwen Code session instead of starting cold, when that run left a thread id and a persisted session store, used the same model and run kind, and is under 7 days old. `createAgentRun` decides once at the one seam every start path shares and stores `agent_runs.resumed_from_run_id`; the workflow restores the prior attempt's `session_store` artifact (a tar.gz of `~/.codex/sessions`, `~/.claude/projects`, or `~/.qwen/projects`, private R2, ≤ 8 MB, never served to members) into the runner's HOME, passes `OPENFLOOR_RESUME_THREAD_ID`, and records `provider_thread_resumed` (1 resumed / 0 fell back to a fresh thread, with a `resume_failed` run event). The brief opens with a short preamble reconciling the thread's memory with the freshly checked-out workspace. Every run — failed and cancelled included — now keeps its thread id and persists its store. `resumableProvider` (`lib/provider-credentials.ts`) excludes only Gemini (CLI resume unverified at the pin); the Qwen Code runner resumes with `--resume <session_id>` and, like the others, falls back to a fresh thread when the CLI cannot find the session (verified Spike Q1 step 4). See the 2026-08-28 decision-log entries.
- PR feedback nudges (`lib/candidate-feedback.ts`, `lib/pr-feedback.ts`, `db/candidate-feedback.ts`): a `check_run`/`check_suite` completion, `status`, submitted `pull_request_review`, or created `pull_request_review_comment` delivery that concerns the session's candidate PR triggers one GraphQL re-observation (`lib/github.ts`'s `getPullRequestFeedback`) of failing checks, unresolved non-bot review threads, and changes-requested reviews, and turns each into an ordinary queue item (`floor_queue_items.origin`, `intent = 'task'`, prompt attributed to the session owner like resolver runs) targeted at the agent whose integrated run last touched the commented paths (CI: the newest integrated run), or left unassigned for the router when that agent is paused/deprovisioned. Dedup state lives in `repository_candidates.feedback_nudges` (per-kind signature/attempts/item, compare-and-set); an unchanged CI signature never re-nudges, review kinds re-nudge at most three times once the prior item is no longer live, and a still-queued nudge item is updated in place. Owner toggle `sessions.auto_inject_feedback` (default on, independent of `auto_dispatch`) via `PATCH /api/sessions/[id]/routing` and the queue settings menu. No CI log tails yet (needs an Actions:read App permission). See the 2026-08-28 decision-log entry.
- Manual agent lifecycle controls: any session member can Pause/Resume or Stop a persistent agent or generated worker; only persistent agents can be deleted. Pause blocks future dispatch while the current run finishes. Stop also pauses, and cancels the current run only for a session-owner caller; the non-owner UI discloses that distinction. Owner-only **Pause all / Resume all / Stop all** includes persistent agents and workers but excludes Concierge. See the `floor_agents` invariant and ENG-138 decision-log entry.

Known production follow-up: the owner discard action still reports failure in the disposable acceptance repository after its Git authentication correction. Preserve the expected-SHA lease and error separation; diagnose this independently rather than weakening deletion safety or folding it into Phase 6.

### Explicitly deferred

- Per-agent reasoning effort (`output_config.effort`). Model selection shipped (creation dialog, closed `PROVIDER_MODELS` allowlist — see the implemented list above); effort is the natural follow-on but a second axis the runners do not thread today.
- Agent-authored chat messages and generic artifact download UI beyond the per-run raw-log and session-brief expanders. (Live run activity streaming is now real: the sandbox runner posts normalized Codex events to `/runtime/run/events`, they persist in `agent_run_events`, and sessions receive them as `run.activity` presence events. An agent may also read live session state mid-run through the `openfloor_session_context` MCP tool — see `/runtime/run/context` in the API table — but it cannot write.)
- Deployment automation after repository merge.
- Agent ownership transfer. Task, model, and billing edits are implemented (`updateFloorAgentSettings`); persistent-agent Pause/Stop/Delete and generated-worker Pause/Stop are implemented (`db/floor.ts`, plus owner-only bulk variants) via nullable `paused_at` and the existing `deprovisioned_at`; `state` remains `created`. Provider stays uneditable by design — it selects the runner, gateway route, skills/MCP support, and credential; a post-hoc switch is a different agent wearing the same name (delete and recreate). Generated activation/retirement remains router-controlled; Concierge has no manual lifecycle controls.
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
| `/app/home/settings` | `/home/settings` | Protected | Account settings: profile, plan and usage, connections, preferences, and account deletion. The account menu supplies an optional membership-checked `from` path so the header can return to the originating home/session/floor page. Nested under `/home` (not its own top-level route) so it shares the `home*` Access destination — see "Authentication and identity". |
| `/app/onboarding` | `/onboarding` | Protected | Two-step first-login setup: profile + required GitHub App installation together, then optional AI provider connections. Every signup is enrolled on Free automatically — the plan step is hidden for now (2026-08-27 decision). Gates `/home`, `/join/*`, and `/session/*` until final submission. |
| `/app/join/[token]` | `/join/[token]` | Protected | Valid invite preview followed by explicit acceptance. |
| `/app/session/[id]` | `/session/[id]` | Protected/member-only | Session lobby, roster, invite controls, leave, and floor entry. |
| `/app/session/[id]/floor` | `/session/[id]/floor` | Protected/member-only | Main collaborative Agent Floor. |
| `/app/api/...` | `/api/...` | Protected | Authenticated application interfaces. |
| `/app/api/sessions/[id]/presence` | `/api/sessions/[id]/presence` | Protected/member-only | WebSocket upgrade. |
| `/app/webhooks/github` | `/webhooks/github` | Public/signed | GitHub delivery boundary; verifies payload size and HMAC before acknowledging. |
| `/app/webhooks/stripe` | `/webhooks/stripe` | Public/signed | Stripe delivery boundary; caps the raw body, verifies Stripe's signature, and reconciles subscription entitlement. |

Important behavior:

- The landing page owns no password, OAuth callback, or application login session.
- `/onboarding`, `/home`, `/home/settings`, and the session lobby share the Archivo/shop-palette `shop-shell` visual system and wave field. Route-specific layout stays under `.onboarding-shell`, `.settings-shell`, or `.session-lobby-shell`; `/join` retains its established styling. `/floor` keeps its own `legacy-floor-*` layout and components, but resolves its tokens onto the same shop palette via a `.app-shell`-scoped block in `tokens.css` — see the Styling section below.
- `/home/settings?from=` is local navigation state, not authority: only `/home` or a current member-visible `/session/[id]` or `/session/[id]/floor` is accepted, and every invalid, stale, or non-member origin falls back to `/home` without revealing the session.
- Clicking Sign in navigates to a protected path; Cloudflare Access performs the login and returns the browser.
- `/signout` is the production sign-out endpoint (an application route, not Cloudflare's own `/cdn-cgi/access/logout` — see "Authentication and identity" for why).
- A join page reveals session title and owner only after authentication and only for a valid, active signed token.
- Opening a join URL does not change membership. The user must click Join.
- Creating a session requires a repository selected from the current user's active account installations and opens the normal lobby only after candidate provisioning is attempted. `repo=required` remains a focused recovery gate for legacy or failed-provision sessions; `setup=1` and `github=setup` are retired.
- Invite acceptance is idempotent because the session membership key is unique.
- Non-members opening a session or floor get a 404-style not-found response rather than session details.
- A member who leaves is disconnected from the room's presence object.
- An owner receives a conflict response if they try to leave.
- An owner can end the session instead. Ending is final in v1 (no un-end), idempotent, revokes the active invite in the same batch, and leaves all data readable. Collaboration, repository, preflight, run, and review mutations on an ended session return `409` with "This session has ended." — never `404`, which clients treat as "kicked from the session". Run cancellation remains available so already-running work can be stopped. Presence sockets stay open on ended sessions by design.
- Repository details are visible to session members, but only the owner can select, configure, disconnect, or reconnect from their account-authorized repositories.
- The GitHub installation callback is protected by Access, signed, expires after 30 minutes, is bound to the initiating user and purpose (`onboarding` or `settings`), and can be consumed once. Returned installation metadata is verified through the configured GitHub App before it is stored.
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

Production identity is Cloudflare Access, not application-owned “Sign in with ChatGPT.” GitHub (primary, since 2026-08-27) and One-time PIN are the intended Access identity providers; Google is removed from the apps' IdP lists (existing Google-created accounts stay reachable — accounts key on email, so the one-time-code path lands in the same account). Since 2026-08-25, the email/one-time-code path is fronted by an app-owned page (`/signin`, `/signin/code`) styled to match the landing — it still authenticates through this same Access application, extracting and re-posting to Cloudflare's own endpoints rather than owning any credential check. The “Continue with GitHub” control is a plain link into Cloudflare's own (branded) picker, exactly the mechanism the Google link used and for the same structural reason — an OAuth IdP's callback needs the team-domain `CF_Session` cookie only a direct browser visit can carry; see the 2026-08-25 decision log entry. `ACCESS_CUSTOM_LOGIN_ENABLED` (`wrangler.jsonc`) gates it — currently on; flipped to "false" it makes `accessSignInPath()` (`app/access-auth.ts`) exactly the pre-2026-08-25 behavior, the rollback path if production sign-in breaks.

**Access is configured as an explicit allowlist, not protect-everything-then-bypass.** A path with no matching Access-application destination is never touched by Access at all — no challenge, no identity header, straight to the Worker. That, not a bypass rule, is what keeps the public landing (`app.opnflr.com/`), static assets, `/webhooks/*`, `/runtime/*`, `/signin`, and `/signin/code` public. This matters because Cloudflare has no "root only" destination syntax: an empty Path and a `*` Path are equivalent and both mean the hostname plus everything beneath it (confirmed against Cloudflare's own app-paths docs after this bit us once — a blank-path "bypass" destination for `/` briefly bypassed the *entire* domain instead). Do not try to reintroduce a protect-everything app with bypass carve-outs for the public paths; list only what must be protected. `/signin` and `/signin/code` must never be added to either Access application's destinations, the same rule `/signout` already follows below — a signed-out or not-yet-signed-in visitor has to be able to reach them without first being challenged.

Self-hosted applications cap at five destinations each, and there are six protected paths, so two applications share one policy (attached to the second via "Add existing policy", not duplicated):

- App 1 ("OpenFloor authenticated users"): `app.opnflr.com/home*`, `app.opnflr.com/settings*`, `app.opnflr.com/onboarding*` (no slash before the star — see below), `app.opnflr.com/session/*`, `app.opnflr.com/join/*`
- App 2 (same policy): `app.opnflr.com/api/*`

**A bare single-page destination needs a no-slash trailing `*` — `home*`, not `home/*`.** Next.js's client-side (soft) navigation doesn't request `/home` — it requests `/home.rsc`, `/settings.rsc`, etc. (confirmed via DevTools: `Request URL: https://app.opnflr.com/home.rsc?_rsc=...`). A bare `home` destination matches only the exact `/home` path, so Access never touches the `.rsc` request at all — no challenge, no identity header, straight to the Worker, same as any unlisted path. `getAccessUser()` then correctly sees nothing and `requireOnboardedUser` issues its own 307 to the landing interstitial, which looks identical to a real session loss (browser cookies are untouched throughout — Access was never in the loop) but only ever fires on soft navigation, never a hard reload. This was the 2026-08-25 root cause of "leaving /settings or a session for /home signs you out."

Cloudflare has two distinct wildcard forms and they are not interchangeable (dashboard Path field already supplies the leading `/`, so what you type is the part after it):
- `home*` (star directly after the segment, no slash) — matches `/home`, `/home/anything`, **and** `/home.rsc`-style superstrings. This is what a bare single-page destination (`/home`, `/settings`, `/onboarding`) needs.
- `home/*` (slash before the star) — matches only `/home/...` (a real trailing segment). It does **not** match the bare `/home` and does **not** match `/home.rsc`. Entering this form on the first attempt at this fix caused a total lockout, including fresh logins in a private tab: Access stopped protecting the exact `/home` path entirely, so every request (soft nav *and* hard reload) fell through to origin with no identity.

`session/*` and `join/*` correctly use the slash form and were never affected: every real request under them already has a mandatory segment after the slash (a session/invite id, e.g. `/session/xyz` or `/session/xyz.rsc`), so there's no bare path to lose coverage on. Same reasoning is why `api/*` (App 2) also correctly keeps the slash form — every API call is `/api/something`, never a bare `/api`, and API calls are plain `fetch()`s with explicit paths, never a Next.js `.rsc` soft-nav request.

**This list is enumerated per path across the two Access applications, not covered by a single top-level wildcard — it is dashboard state, external to this repo (`docs/cloudflare-access-branding.md`).** Adding any new protected page requires adding its path (with its own trailing `*`) to whichever app has room (or a new app sharing the policy) in the Zero Trust dashboard in the same change; forgetting this step causes exactly the failure mode the (now-fixed) 2026-08-21 gap did — the page bounces every visitor back to sign-in because Cloudflare Access never attaches an identity header to it, `getAccessUser()` (`app/access-auth.ts`) sees nothing to trust, and `requireAccessUser`/`requireOnboardedUser` redirect to the landing interstitial regardless of whether the visitor is actually signed in elsewhere in the app.

**App 2's only destination is a wildcard path, so its App Launcher tile must stay hidden.** Cloudflare's App Launcher launches "the application's hostname" — the single domain configured on the app — so App 2's tile would otherwise be the literal, unroutable `app.opnflr.com/api/*`. A user re-entering through `openfloor.cloudflareaccess.com` after signing out has two openfloor tiles (Cloudflare gives a separate tile per app on one hostname) and a coin-flip chance of picking the broken one — this was the 2026-08-24 post-logout dead-end bug. Fix: App 2's **Experience settings → "Show application in App Launcher"** must stay off. Also confirm **Cookie Path Attribute** is off on both apps — enabling it forces re-authentication when moving between App 1's paths and App 2's, which the page/API split across one hostname would turn into constant re-auth churn.

Zero Trust → Settings → "Require Access Protection" must stay off. If enabled, an unmatched hostname/path is blocked (error 1050) instead of passed through, breaking the "unlisted = public" assumption this whole setup relies on.

The Worker validates the `cf-access-jwt-assertion` using:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD` — a comma-separated list, one tag per Access application (`lib/identity.ts`'s `parseAudienceList`). Two apps on one hostname means a page load and its first `/api` call can carry JWTs minted for two different AUD tags; whether a single `CF_Authorization` cookie's `aud` claim merges both apps' tags is undocumented by Cloudflare, so the Worker trusts either tag explicitly rather than depending on that.
- the team's JWKS at `/cdn-cgi/access/certs`
- issuer, audience, signature, and token expiry through `jose`

The provider user ID is stored as `cloudflare-access:<sub>`. Email and name are mutable display metadata, not identity keys.

**Sign-out is `/signout` (`app/signout/route.ts`), not Cloudflare's `/cdn-cgi/access/logout` directly.** Neither Cloudflare logout endpoint (app-domain or team-domain) accepts a `returnTo`, and the app-domain one only clears the app-domain cookie — the team-domain global Access session survives, so the next sign-in silently re-authenticates the same identity with no prompt. `/signout` clears the app-domain `CF_Authorization` cookie itself, then returns a small HTML page that ends the team-domain session too: a cross-origin `no-cors` `fetch(..., { credentials: "include" })` to the team-domain logout URL, which carries and clears cookies the same as a real navigation would without leaving `app.opnflr.com`, then `window.location.replace("/")`. It must stay outside both Access applications' destinations so a signed-out user can still reach it. The user lands on the app's own landing page (`app/page.tsx`), not Cloudflare's hosted "logged out" page.

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
- The inbound cascade set now also includes `github_account_connection_states.user_id` and `user_github_installations.user_id`; the historic four-FK count in the migration warning below predates account-level GitHub setup. This strengthens, rather than changes, the never-recreate invariant.
- `prior_email_hash` (nullable text, migration `0033_wonderful_blur.sql` — renumbered from `0032_nostalgic_hex.sql` when `0032` landed first from account-level GitHub setup) and `free_allowance_used_at` (nullable integer, same migration) implement "a deleted account's email cannot reclaim the free plan's hour allowance." `deleteAccount` computes `prior_email_hash` from the row's pre-scrub email via `lib/account-email-hash.ts`'s `hashAccountEmail` (HMAC-SHA256, keyed by `INVITE_SIGNING_SECRET`, domain-separated from invite signatures by a distinct prefix — never the plaintext email) and stamps it on the tombstone. `upsertUser`'s new-account INSERT branch (only that branch — never the two lookup-and-update branches) checks for any row with a matching `prior_email_hash` and, if found, sets `free_allowance_used_at` on the fresh row. `lib/plans.ts`'s `planHourLimit(plan, freeAllowanceUsed)` is the only place that reads the flag: it returns `0` instead of `PLAN_LIMITS.free.hours` when the *effective* plan is `free` and the flag is set, so the `@opnflr.com` unlimited-testing override and any active paid plan are unaffected regardless of history — only a lapse back to free re-applies the zero. Rotating `INVITE_SIGNING_SECRET` invalidates every stored `prior_email_hash` and fails open (a returning address regains the allowance), never closed. Seats are deliberately untouched — the abuse vector this closes is metered hours, not invite/join capacity. See the 2026-08-26 decision-log entry.
- **`users` must never be recreated via a Drizzle table-swap migration once it holds real rows.** It has six inbound `ON DELETE CASCADE` foreign keys (`session_members.user_id`, `session_invites.created_by`, `github_connection_states.user_id`, `github_account_connection_states.user_id`, `user_github_installations.user_id`, `user_provider_credentials.user_id`); a `DROP TABLE users` cascade-deletes all six even inside the standard `PRAGMA foreign_keys=OFF` migration wrapper drizzle-kit generates for a table with a named CHECK constraint — confirmed by rehearsing the generated migration for `plan_status` against seeded local data during the plan-limits work (`drizzle/0019_redundant_may_parker.sql` was hand-fixed to a plain `ALTER TABLE ADD COLUMN` instead, the same technique `0018` already used for `plan` itself). `deleted_at` (`drizzle/0020_regular_cardiac.sql`) is a nullable, unconstrained column, so drizzle-kit generated a plain `ALTER TABLE ADD COLUMN` on its own — no hand-fix needed; `prior_email_hash`/`free_allowance_used_at` (`drizzle/0033_wonderful_blur.sql`) are the same shape and needed none either. Any future change to this table's CHECK-constrained columns still needs the same hand-fix, or a genuinely different migration strategy (backfill into a new table, dual-write, swap) — never a bare `db:generate` accept.

**Account deletion.** `deleteAccount` (`db/sessions.ts`) cannot issue a hard `DELETE FROM users`: roughly a dozen columns across `floor_messages`, `floor_agents`, `floor_queue_prompts`, `repository_candidates`, and other tables reference `users.id` with no cascade action, and the invariant above rules out adding one via a table recreate. Repository state (a live candidate) no longer blocks account deletion — `DELETE /api/account` first checks only for an in-progress GitHub integration on any owned session (a Workflow actively pushing under the candidate's `integration_run_id` lease; deleting its rows mid-flight would strand a real push), immediately cancels all known non-terminal Stripe subscriptions without refund (settling, rather than failing on, a subscription Stripe already stopped billing — canceled out-of-band or unknown to the current key; see the 2026-08-27 deletion-cancellation decision), best-effort abandons (and, if the caller asked, attempts a lease-verified GitHub branch delete for up to 3 of) any owned sessions' live candidates via `lib/candidate-abandon.ts`, then calls `deleteAccount`, which rechecks the integration-lease blocker before writing. A Stripe failure leaves the account intact. After successful cancellation, `deleteAccount` performs this D1 batch:

1. Pre-checks every session the user owns for the same in-progress-integration guard `deleteSession` uses (`getBlockingIntegrationRunId`). Any blocked session refuses the *entire* deletion and nothing is written — the account and every session stay exactly as they were.
2. Hard-deletes every session the user owns (children cascade with the session, same as `deleteSession` — any live, unabandoned `repository_candidates` row cascades away with it too; only a caller that explicitly asked to delete its branch on GitHub got the chance to do so first).
3. Drops the user's membership and `floor_assignments` rows in sessions *other* people own (`session_members` would cascade on its own; `floor_assignments` has no FK action, the same reason `leaveSession` deletes it explicitly), plus `user_provider_credentials`, `user_github_installations`, and `github_account_connection_states` rows — those tables' cascade FKs never fire because step 4 scrubs the users row instead of deleting it.
4. Scrubs and releases the identity: `chatgpt_user_id` and `email` are rewritten to values the IdP can never present again (`'deleted:' || id`, `'deleted+' || id || '@invalid'`), name/handle/avatar are cleared, `display_name` becomes `"Deleted user"`, `plan_status` becomes `canceled`, `seat_limit` becomes null, `prior_email_hash` is stamped with the departing address's HMAC, and `deleted_at` is stamped. `upsertUser`'s two identity lookups both add `AND deleted_at IS NULL`, so the next sign-in with the same Access identity creates a brand-new row rather than resurrecting the tombstone.

Deliberately left alone: `usage_months` rows survive (see that table's own no-FK note — "future account deletion" is this), and authored `floor_messages`/`floor_agents`/`floor_queue_prompts`/`repository_*` rows in sessions the user did not own survive too, now attributed to the scrubbed `"Deleted user"` display name — the tombstone row exists specifically to keep those foreign keys valid.

#### `sessions`

- UUID, title, nullable objective, timestamps.
- `updated_at` advances on every floor mutation (`bumpFloorRevision` touches it alongside `floor_revision`), so it cannot stand in for "the objective was last edited." `objective_updated_at` is the dedicated column, set only by `updateSessionObjective`; it drives the owner-only objective-nudge banner (`lib/floor-state.ts`'s `countMessagesSinceObjective`).
- `floor_revision` is a monotonically increasing integer for persisted floor reconciliation.
- Session creation requires an active account GitHub installation and server-resolved repository. It verifies the repository's default-branch SHA before writing, then creates session, owner membership, active invite, repository connection, and a `creating` candidate reservation in one D1 batch.
- Nullable `ended_at` is the lifecycle marker. Null means live; a timestamp means ended and read-only. Writes authorize through `getActiveMembershipRole` (throws `SessionEndedError` for members of ended sessions); reads keep using `getMembershipRole` so ended sessions stay viewable. `leaveSession`, `endSession`, `deleteSession`, and non-member concealment intentionally bypass the ended guard.
- `auto_dispatch`, `auto_provision_agents`, `auto_resolve_conflicts`, and `auto_inject_feedback` (PR feedback nudges, default on, migration `0041_spicy_wilson_fisk.sql`) are separate owner-controlled routing settings. Auto-dispatch and conflict resolution default to true, but conflict resolution never authorizes ordinary prompt dispatch; generated-agent provisioning requires auto-dispatch. `auto_dispatch`'s SQL column default remains `false` to avoid a destructive table recreate, while `createSession` inserts `auto_dispatch = 1` and migration `0027_workable_wild_pack.sql` backfills existing live sessions. New sessions default provisioning on while migration `0028_great_sinister_six.sql` backfills existing sessions off. Nullable `auto_agent_provider` (TS-only enum over the same provider ids as `floor_agents.provider` — it lagged behind by `glm` until 2026-08-28) stores an explicit owner choice when multiple connected, rollout-enabled providers exist. `PromptQueue.tsx` also lets an owner/author manually target an unassigned queued item independently of auto-dispatch. An authorized conflict answer from the session owner or an original prompt author explicitly authorizes conflict resumption even when automatic conflict resolution is off.
- Retention: the Worker's `scheduled()` handler (daily cron in `wrangler.jsonc`) runs `purgeExpiredSessions`, deleting repository-free sessions with `ended_at` older than `ENDED_SESSION_RETENTION_MS` (30 days), then broadcasts `members.changed` so connected tabs refetch. Never-ended sessions and sessions with any repository connection are never purged automatically — this guard is independent of and stricter than manual deletion's, which only blocks on an in-progress GitHub integration and otherwise lets the owner choose a live candidate's fate (see "Account deletion" and the 2026-08-26 candidate-abandonment decision-log entry).
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

- Composite primary key `(user_id, provider, kind)` — widened from `(user_id, provider)` on 2026-08-24 so one user can hold an API key AND a subscription credential for the same provider. That widening was the one table recreate this table has had (SQLite cannot alter a primary key in place; migration `0030`, renumbered from `0025` after main landed its own `0025`–`0029` — the `0024` precedent; a drizzle `__new_` swap, safe because nothing references this table and the copy preserves `created_at`). `provider` (`anthropic`/`openai`/`kimi`/`gemini`/`glm`/`qwen`/`deepseek`) and `kind` (`api_key`/`oauth`) remain open enums — TS-typed with **no SQL CHECK** (the `agent_run_artifacts.kind` convention) so adding an enum *value* never requires a recreate; the earlier "never requires a table recreate" claim is corrected to enum values only.
- `ciphertext` is the AES-256-GCM encryption of the stored secret (`lib/credential-crypto.ts`): key derived by SHA-256 from the `CREDENTIAL_ENCRYPTION_KEY` Worker secret, fresh 96-bit IV per write, and `credentialAadContext` bound as AAD so a ciphertext copied to another row fails to decrypt — the bare legacy `"<userId>:<provider>"` for `api_key` rows (existing rows stay decryptable, nobody reconnects) and `"<userId>:<provider>:<kind>"` for newer kinds. Rotating the secret invalidates every stored credential; users reconnect.
- Write-only from the client: no endpoint returns a stored value. Reads return `fingerprint` (last four characters — of the token for `api_key`/setup tokens, of the ChatGPT `account_id` for auth bundles, never a refresh token), `kind`, and `validated_at` (set on connect after a successful models-endpoint check — for `api_key` rows and for anthropic setup tokens, which `GET /v1/models` authenticates with a plain Bearer; null only where no free probe exists, e.g. a ChatGPT bundle — "Connected — not yet verified").
- `kind` is `api_key` or `oauth`. An `oauth` row stores a pasted subscription credential the user minted themselves (`claude setup-token` output, a Kimi Code plan key from the plan console, or a ChatGPT `auth.json` bundle) — a paste-a-credential flow, not an openfloor-operated OAuth login (which remains out of scope; see the §Out-of-scope note in the 2026-08-24 credential-kinds decision entry). The kind name is the second-credential slot ("the member's own subscription seat"), not a claim about the token's protocol — a Kimi Code plan key is not literally an OAuth token. `credentialKindsForProvider` allows `oauth` for `anthropic`, `kimi`, and `openai` (openai's bundle kind was withheld 2026-08-25 and went live 2026-08-26 when Spike D passed), enforced at the PUT route and at gateway resolution. Refreshing a ChatGPT bundle server-side is **not** an openfloor-operated OAuth login: it exchanges a refresh token the member minted themselves, using the vendor's own public Codex CLI client id — the same call their laptop makes. Actual login flows stay out of scope. A server fallback credential is always `api_key` by construction — plain string bindings — and openfloor never operates one person's subscription seat for others.
- The `ON DELETE CASCADE` FK to `users` never fires in practice — `deleteAccount` scrubs the users row rather than deleting it, so it deletes these rows explicitly in the same batch.
- **AAD binds ciphertext to the user id, so account identity operations must preserve that id.** Every runtime path does: `upsertUser`'s cross-method email fallback and its `ON CONFLICT(email)` insert both re-key the *same surviving row* — the id never changes (pinned by a test in `tests/worker/credentials.test.ts`). The one historical row-collapse (migration `0022_account_email_merge`) predates this table in migration order, so no credential row can ever have existed for a merged-away account. Any *future* migration that collapses two `users` rows must explicitly migrate (decrypt-and-re-encrypt under the winner's id) or delete the losing row's credentials — silently orphaning undecryptable ciphertext is not acceptable.
- Owner credential resolution (`getRunAgentOwnerCredential`, wrapped by the shared `resolveRunProviderSecret` ladder every gateway calls) requires `removed_at IS NULL` on the membership row, following the member-removal convention; credentials themselves belong to the user, not a membership, so removal from a session never touches them. The join also narrows by the agent's `credential_kind`: a named kind matches only its own row, and the caller can distinguish "owner has nothing" (server fallback allowed) from "owner lacks the named kind" (refuse).

#### `github_connection_states`

- Retained only as additive migration rollback support for the superseded session-bound connection workflow. Live routes create and consume `github_account_connection_states` instead.

#### `user_github_installations` and `github_account_connection_states`

- `user_github_installations` stores opaque association ID, user, GitHub installation ID, account login/type display metadata, `active`/`revoked` status, and timestamps. `(user_id, installation_id)` is unique; multiple installations per user are valid.
- `github_account_connection_states` binds one signed 30-minute, single-use callback state to a user, purpose (`onboarding` or `settings`), and safe return path. Callback verifies the installation through the configured GitHub App before atomic consumption/upsert.
- Repository lists aggregate active installations and deduplicate by GitHub repository ID. Browser input carries association ID and repository ID; every mutation resolves both against the signed-in user and re-reads GitHub access server-side.
- Removing an association deletes only future selection authority. Existing `repository_connections` retain their installation ID and continue operating. GitHub uninstall/suspend webhooks mark all matching associations revoked and preserve live-session revocation behavior; restore events reactivate retained associations.
- Migration `0032_thick_hiroim.sql` backfills active associations from accessible existing repository connections using `connected_by`; old code ignores both additive tables, so code rollback is safe without destructive contraction.

#### `repository_connections`

- There is at most one row per session.
- Numeric GitHub installation and repository IDs are stored as strings and remain authoritative across repository renames; owner/name/full-name are display metadata.
- Status is `connected`, `ready`, `revoked`, `inaccessible`, `externally_modified`, or `disconnected`; GitHub is authoritative and synchronization never repairs a changed ref automatically.
- Disconnect changes status to `disconnected` and preserves connection, candidate, and check history.

#### `repository_candidates`

- Durable rows record session-derived candidate name and description, exact base SHA, generated candidate ref, expected candidate SHA, last observed remote SHAs, and synchronization time.
- A partial unique index permits only one live (`creating`/`active`, `merged_at IS NULL`, `abandoned_at IS NULL`) candidate per session.
- Candidate refs are generated only by the server as `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>` and are created without force from the selected repository's default branch. openfloor normalizes the session title into a lowercase ASCII slug and retains the unique ID suffix. Retry first reconciles the exact recorded branch/SHA; a mismatched ref is never forced or deleted, and recovery uses a newly recorded attempt.
- A newer base SHA marks the candidate behind; an unexpected candidate head marks the connection externally modified. Neither condition rewrites GitHub.
- The `status` column itself only ever holds `creating`, `active`, or `creation_failed`; there is no `merged` or `abandoned` value in the D1 CHECK. Both are derived read-layer states — `db/repositories.ts`'s `mapCandidate` reports `merged` whenever `merged_at IS NOT NULL` and `abandoned` whenever `abandoned_at IS NOT NULL` (checked in that order; a candidate is never expected to have both), regardless of the stored `status`. Only creating/active rows with neither timestamp set participate in the one-live-candidate constraint, so merged or abandoned history never blocks the next cycle.
- The row stores the active PR identity/state plus GitHub mergeability, merge-requirement state, aggregate observed-check result, ready/merge audit timestamps, confirmed squash SHA, and cleanup outcome. The first draft PR uses the persisted candidate name as its title and description as its body.
- `review_decision` (nullable TS-only enum `approved`/`changes_requested`/`review_required`) and `feedback_nudges` (nullable JSON, `lib/pr-feedback.ts`'s `FeedbackNudgeState`: per feedback kind `{ signature, attempts, queueItemId }` plus a nonce) are written only by `db/candidate-feedback.ts`'s `recordFeedbackNudges`, with a compare-and-set on the previous `feedback_nudges` value so two concurrent webhook deliveries cannot both insert nudge items. Migration `0041_spicy_wilson_fisk.sql`, plain `ALTER TABLE ADD` columns.
- `abandoned_at` (nullable, migration `0032`) is the owner's deliberate retirement of a still-live candidate without merging — set only by `markCandidateAbandoned`, called through `lib/candidate-abandon.ts`'s `abandonSessionCandidate`, which is the one shared path for retiring a live candidate: session deletion's candidate choice, account deletion's pre-flight, and the standalone **Abandon candidate** action in Review (`ReviewScreen.tsx`) all call it. It refuses under the same `integration_run_id` lease as merge/end/delete, and optionally attempts the same lease-verified `deleteVerifiedBranches` (`lib/repository-cleanup.ts`) branch cleanup as a post-merge delete — a branch that doesn't verify-delete is left orphaned on GitHub, not silently dropped, and the operation is retryable (calling it again on an already-abandoned candidate whose branch didn't delete the first time retries only that part). See the 2026-08-26 candidate-abandonment decision-log entry.

#### `repository_candidate_files` and `repository_candidate_checks`

- These tables store a bounded, last-reconciled GitHub PR review snapshot. Files contain path, change kind, counts, and bounded patch preview; checks normalize GitHub check runs and commit statuses to passed/waiting/failed.
- GitHub remains authoritative. Ready and merge mutations refresh these tables before deciding, and webhook events invalidate the review revision so clients refetch.
- Complete logs, bundles, and unbounded diffs remain outside D1.

#### `github_webhook_deliveries`

- The GitHub delivery ID is the primary key, so a replay is acknowledged without applying its state transition twice.
- Installation, repository-access, repository rename/delete, push, pull-request, check-run/check-suite, and status events update or invalidate repository/review state only after raw-body HMAC verification. Completed check-run/check-suite, status, submitted pull-request-review, and created pull-request-review-comment deliveries that concern the candidate PR additionally re-observe GitHub and may queue PR feedback nudges (the App must subscribe to the two review events — `docs/github-production.md`).

#### `repository_check_commands`

- The table remains in the schema, but no live code path reads or writes it this release: the feature is removed and slated for redesign next release. Preflight (`Verify runner`) is dark behind `PREFLIGHT_ENABLED = false` as a result — it has nothing to execute without configured commands.

#### `repository_preflights` and `repository_preflight_checks`

- One `provisioning` or `running` preflight may exist per session; terminal history is retained.
- A preflight pins the active candidate ID and SHA and snapshots each required command in order.
- D1 owns bounded status, timing, exit code, excerpt, and R2 log-key metadata. Full bounded logs stay in private R2 and never enter snapshots.
- Statuses are `provisioning`, `running`, `passed`, `failed`, `cancelled`, or `timed_out`; check statuses are `pending`, `running`, `passed`, `failed`, or `timed_out`.

#### `agent_runs`, `agent_run_events`, `agent_run_checks`, `agent_run_files`, and `agent_run_artifacts`

- One active run may exist per queue item. Runs pin the agent, candidate, exact SHA, attempt, model, prompt inputs, timestamps, and terminal summary.
- The owner may start or cancel; members may read caller-visible run summaries but receive no mutation controls. Unassigned or nonqueued items cannot execute.
- Run statuses are `provisioning`, `running`, `checking`, `ready`, `publishing`, `published`, `integrating`, `integrated`, `conflicted`, `failed`, `cancel_requested`, and `cancelled`; every listed status is now used by the Phase 6 lifecycle.
- `agent_run_checks` stays in the schema but is never populated this release (check commands are removed). D1 stores bounded output excerpts, file metadata, and diff previews; complete bounded Codex logs and diffs stay in private R2.
- `agent_run_artifacts.kind` is `codex_log`, `diff`, `prompt`, `conflict_snapshot`, or `session_store` (UPSERT-keyed on `(run_id, kind)`; no SQL CHECK, TS-enum only). `session_store` is the provider's own session directory tarred at run end for thread resume; `getRunArtifactKeysForMember` excludes it in SQL, so the artifacts route can never serve a transcript. `prompt` is the exact session brief written to the agent's workspace, persisted so members can see what a run was actually told (`components/session/AgentCard.tsx`'s second expander). `GET /api/sessions/[id]/runs/[runId]/artifacts` defaults to concatenating only `codex_log` + `diff` (unchanged from before `prompt` existed); an explicit `?kind=` returns exactly one artifact with no heading.
- `ready` means checks passed locally. The Workflow immediately moves through `publishing`, `published`, and serialized `integrating`; success records `integrated` and completes the queue item, while a true GitHub merge conflict records `conflicted` and idempotently creates or advances its durable conflict case.
- Each new run stores a server-generated run branch, bundle key/size, local bundle commit, trusted published commit, observed remote SHA, publication time, and nullable discard audit fields. Older Phase 4 runs may have null publication fields.
- The agent Sandbox uploads a bounded incremental bundle through an operation-scoped JWT. A separate clean publisher Sandbox reconstructs the deterministic archive baseline from the exact candidate tree, verifies one ref and one result commit, compares the recorded file set, enforces object/file limits, and performs a fixed non-force push with a repository-limited token. Git-over-HTTPS authenticates with `x-access-token` plus the installation token as the HTTP Basic password; REST-style Bearer authentication is not valid for this Git transport. Restarting a Workflow whose run is already `publishing` resumes from the stored bundle and file metadata without rerunning Codex or checks.
- Discard reads the current remote ref and deletes with `--force-with-lease=<expected-sha>` only when the server-generated branch and recorded/reconciled SHAs still match. D1/R2 audit history remains.
- The active candidate holds at most one `integration_run_id`. Each integrating Workflow reconciles base, candidate, and run refs from GitHub, merges the immutable run commit into the latest candidate without force, updates the expected/remote candidate SHA, and creates a draft PR only when the candidate has none. Conflict resolution creates a new immutable resolver run and branch; it never rewrites any source or earlier resolver branch.
- Workflow-file changes under `.github/workflows/` are rejected because the GitHub App has no Workflows permission.
- `branch_deleted_at` records verified post-merge cleanup separately from owner-requested discard; both retain the run and its audit metadata.
- `codex_thread_id` is written for every outcome — `setRunProviderThreadId` runs after the log artifact, before the cancelled/failed returns — so a crashed or cancelled attempt is still resumable. `resumed_from_run_id` (nullable soft reference, deliberately no FK) names the earlier run whose thread this run continued, chosen by `createAgentRun` via `lib/run-resume.ts`'s `pickResumeSource` (same agent and candidate; same queue item or the item's `source_run_id`; same model and kind; thread id and `session_store` artifact present; ≤ 7 days); `provider_thread_resumed` is null (fresh), 1 (resumed), or 0 (asked to resume, runner fell back to a fresh thread — also a `resume_failed` run event). Resolver runs never resume. Migration `0040_eager_thor.sql`, plain `ALTER TABLE ADD` columns.
- `kind` (nullable, TS-only open enum, no SQL CHECK — same convention as `agent_run_artifacts.kind`) is `reply` for a read-only run that answers a question or non-actionable prompt instead of editing the repository, `null` for an ordinary task run. A reply run still checks out the real candidate SHA and calls the provider (the answer reads real repository code plus the session brief), but `createAgentRun` inserts it with `run_branch = NULL` and no `agent_run_checks` rows, and `worker/agent-run-workflow.ts` branches to a short path after the provider produces `final_response`: no file collection, no required checks, no bundle export, no publish, no integrate. Its provider posture is read-only in the same layer each runner already isolates in: Codex `sandboxMode: "read-only"`, the Claude SDK's positive `tools` list drops every file-modifying tool, and the Gemini and Qwen Code runners drop the workspace from srt's `allowWrite` (their own tool-exclude/`permissions.deny` lists are belt-and-braces, since `run_shell_command` bypasses named-tool exclusion) — all defense in depth, since a reply run never reaches the export/publish step regardless. `finishAgentReply` (not `finishAgentRun`) completes its queue item outright on success; `finishAgentRun`'s `ready → blocked` parking exists for a task run that still has to publish and integrate, which a reply never does.

#### `agent_run_rollback_groups`, `agent_run_rollback_group_items`, and `agent_run_rollbacks`

- Each row is one durable attempt to undo an `integrated` run from the still-open active candidate. Status is `requested`, `running`, `completed`, or `failed`; one active and one completed attempt per run are enforced by partial unique indexes, while failed attempts remain audit history and may be retried.
- The rollback unit is the integrated run/queue item, not an individual text fragment inside a merged multi-prompt item: one run produced one repository commit. The session owner may roll back any eligible run; the agent owner may roll back work produced by their agent; an engineer may roll back a run only when they authored every prompt in that item, so one author cannot undo a collaborator's merged prompt.
- One rollback group contains one or more ordinary per-run attempts through `agent_run_rollback_group_items`. Single-prompt rollback creates a one-item group. Engineer and agent groups are owner-only: engineer scope includes only groups whose prompts are all authored by that engineer and reports mixed-author groups as exclusions; agent scope includes every active integrated group produced by that software agent. Existing ungrouped rows and legacy `rollback` Workflow payloads remain supported during rollout.
- `repository_candidates.integration_run_id` is the shared candidate-operation lease for both integration and rollback. A group claims it once with the newest target run, pins the exact previewed candidate SHA and ordered target run IDs, and refuses a stale SHA or changed target set. The Workflow reverts immutable `integrated_candidate_sha` commits newest-first with `--no-commit`, creates one deterministic inverse commit, then reconstructs the same commit in a clean publisher Sandbox. Check commands are removed this release, so the inverse commit publishes without a verification gate.
- Publication pushes that exact reconstructed commit with `--force-with-lease=<expected-sha>` to the server-owned candidate ref and reconciles GitHub before D1 records the new candidate head. Every child completes or fails with the same commit/reason. The old groups, prompts, runs, branches, files, checks, artifacts, and events are never removed. Completed rollbacks are excluded from active Review contributors and the session brief's “already integrated” section, but remain in Review History. If GitHub advances before final D1 recording, the candidate lease remains held for operator recovery.

#### `merge_conflict_cases`, `merge_conflict_attempts`, `merge_conflict_questions`, and `merge_conflict_selections`

- One `merge_conflict_cases` row exists per original source run (`source_run_id` unique). If a resolver result later conflicts because the candidate advanced, `latest_source_run_id` moves to that resolver instead of creating a nested case. All source and resolver runs remain durable audit records.
- Case states are `pending`, `resolving`, `awaiting_input`, `resolved`, `failed`, and reserved `cancelled`. Normal flow is `pending` to `resolving` to `resolved`; a question request moves `resolving` to `awaiting_input`, and the first complete answer set from the session owner or a current original prompt author moves it to `pending` for an answer-authorized resume.
- `automatic_attempts` permits two automatic launches since the last complete human answer. Failed attempts return to `pending` while budget remains, then become `failed`. Explicit resolver cancellation becomes attention-required `failed` without an automatic relaunch, so the owner's cancel action is not immediately undone. An owner-only manual start/retry sets `resume_requested`; stable provider blocks do not freeze ordinary work.
- Each resolver remains a normal `agent_runs` row associated through `merge_conflict_attempts`, with launch kind `automatic`, `manual`, or `answer`. It inherits the latest source run's agent, pinned provider/model, and agent-owner billing policy. Queue and Review derive `purpose: "conflict_resolution"` and label it “Merge Resolver”; no `floor_agents` row is created. The source agent's own floor card instead reflects the case's state directly (`AgentCard`/`AgentSpotlight`'s `conflict` prop, computed in `Workspace.tsx` from `review.conflicts` keyed by `agentId`): red (`data-status="blocked"`) while `pending`/`resolving`, amber and breathing (`data-status="needs-input"`, the existing status-overlay animation, gated by `prefers-reduced-motion`) while `awaiting_input`/`failed`, and its own click navigates straight to that case in Review instead of focusing the tile.
- Resolver workspace construction downloads the latest candidate archive, the source run's exact candidate archive, and that run's previously verified private-R2 Git bundle. It creates a shared synthetic base, restores the immutable source result, performs a real three-way merge into the latest candidate, persists up to 100 actual unmerged paths, and leaves genuine markers for the resolver.
- Immediately after that merge, every attempt (automatic or manual) also captures a `conflict_snapshot` `agent_run_artifacts` row: a Node script run in the same sandbox reads each unmerged path's git stages 1/2/3 (base/ours/theirs, null when that stage doesn't exist) plus the working-tree file with markers intact, each side bounded to 16 KiB, capped to the first 40 conflicted paths. `agent_run_artifacts.kind` is a TS-only Drizzle enum with no SQL `CHECK`, so adding this kind needed no migration. `lib/conflict-hunks.ts` parses a "content" file's markers into real hunks and turns the three whole-file kinds (`delete_modify`, `modify_delete`, `binary`) into one synthetic hunk each; a file that fails to parse is marked unparseable and excluded from selection rather than failing the request.
- `merge_conflict_selections` records one human's per-hunk choice (`ours`/`theirs`/`both`, TS-only enum) against one snapshot's `agent_run_artifacts.run_id`. Recording requires a choice for every hunk the snapshot's own fresh parse has (the API route recomputes that set from the same R2 body rather than trusting the client), then resumes the case via the same `resume_requested`/`pending` transition as a manual retry, gated by a scalar subquery so only a submission naming the *current* latest snapshot succeeds — a stale one returns `409`, matching `merge_conflict_questions`' first-complete-submission-wins rule. The resulting resolver attempt is launch kind `manual` (that column keeps its SQL `CHECK`, so this reuses the existing value rather than adding one); its workflow re-parses its own fresh merge and, only if every conflicted path and hunk still lines up with the recorded selections, rewrites each marker block directly with `lib/conflict-hunks.ts`'s `applyConflictSelections` and skips launching an agent process entirely — no model call, no tokens. Any mismatch (the candidate moved, a path the snapshot never reached) discards the selections for that attempt and runs the resolver agent normally instead of guessing.
- Publication refuses any remaining unmerged index entry or conflict marker, collects the complete candidate-relative diff, runs ordered checks, then uses the existing bundle validation, non-force publication, candidate lease, GitHub reconciliation, and draft-PR integration. Partial work is discarded when input is requested.
- `merge_conflict_questions` stores one to three ordered questions per request plus answers, responder, and timestamps. The runtime request accepts an explanation up to 4,000 characters and questions up to 500 each. Answers are restricted to the active session owner or an active user who authored at least one prompt on the original source queue item; unrelated active members and outsiders receive concealed `404`. Answers are required, up to 2,000 characters each, must match the exact unanswered set, and use a first-complete-submission-wins conditional update. Stale authorized races return `409`. `merge_conflict_selections` uses the identical authorization predicate.
- Resolved cases remain in Review audit data but no longer emit active conflict warnings. `awaiting_input` and `failed` cases produce reload-safe attention UI, now including a "Resolve manually" affordance in the conflict center's case panel whenever the case `hasSnapshot`.

#### `floor_agents`

- Session-scoped UUID.
- Creator and owner are real users; owner must be a member of the same session.
- Name, free-text role, and task are required user input.
- `name_key` is NFKC-normalized, whitespace-collapsed, and lowercased for case-insensitive uniqueness per session.
- The only valid lifecycle state is currently `created`.
- `provider` (`anthropic`/`openai`/`kimi`/`gemini`/`glm`/`qwen`/`deepseek`, TS-only open enum, default `openai`) selects the run runner; nullable `model` overrides the provider's default and is chosen in the create dialog from the closed per-provider allowlist `PROVIDER_MODELS` (`lib/provider-credentials.ts`; first entry = the default, `DEFAULT_PROVIDER_MODELS` is a derived alias pinned by a unit test). `parseAgentInput` rejects an id outside the agent's provider's list, so an unknown model is a `400` at creation, never a vendor 404 mid-run. The allowlist is a constant on purpose — it goes stale until edited (a code change, the correct direction for that failure), and it is per provider, not per credential (plan entitlements surface as the vendor's own run-start error). Nullable `credential_kind` (TS-only open enum, no default) says which of the owner's credential kinds pays for this agent's runs: null means "the owner's default" (api_key when connected, else the single existing row), so pre-existing agents bill exactly what they billed before; a named kind the owner lacks refuses the run with an actionable `503` — never the other kind, never the server key. The create dialog offers the choice (Billing field) only for providers with more than one kind and never reveals which kinds the chosen owner has actually connected. The agent's own stored `credential_kind` (and `model`) is member-visible — it's in the floor snapshot (`FloorAgent.credentialKind`) and on the spotlight identity line: that is the agent's property, chosen in a dialog every member can open, not the owner's private connection state, and it is what makes the run-time "connect it or change the agent" refusal diagnosable. Creation offers only providers whose rollout flag is on (`CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, `GEMINI_RUN_ENABLED`, `GLM_RUN_ENABLED`, `QWEN_RUN_ENABLED`, `DEEPSEEK_RUN_ENABLED`; the dialog's provider field renders once more than one is enabled), and the API refuses a gated provider with `503` — a gated-provider agent cannot be *created*. Agents created while a flag was on persist through a flag rollback by design and degrade correctly: auto-dispatch skips their items, manual runs return `disabled`.
- `kind` (nullable, TS-only open enum, no SQL CHECK) is `answer` for Concierge, `worker` for generated task agents, and `null` for ordinary persistent user-created agents. Generated rows are identified by kind, never name; their owner/creator is the session owner and their metadata is system-owned/read-only. Nullable `deprovisioned_at` hides an idle generated row from floor snapshots, targeting, ranking, and session context without deleting queue/run history. The router lazily creates or reactivates only the rows needed for dispatch capacity, allocating distinct Concierge rows to concurrently claimed/busy replies. Retries reactivate their original row to preserve attribution.
- Generated-agent provider resolution uses `sessions.auto_agent_provider` when it still names a connected, rollout-enabled owner credential; otherwise one enabled owner credential selects itself, multiple require an explicit choice, and zero use OpenAI's existing owner-key/server-key/refuse ladder. Concierge uses the same policy and lifecycle. Regardless of prompt classification or manual targeting, `db/runs.ts` forces every Concierge run to `kind = 'reply'`, with no branch or checks, so Concierge cannot execute writable code changes.
- Manual lifecycle control applies to persistent agents and generated workers (`kind IS NULL OR kind = 'worker'`); Concierge remains exclusively router-controlled. Nullable `paused_at` blocks new router assignment/dispatch immediately; a currently in-flight run is left to finish. Any session member may Pause/Resume (`pauseFloorAgent`) or Stop (`stopFloorAgent`, which always sets `paused_at` but only cancels the active run through owner-only `requestAgentRunCancellation` when the caller is the owner). Delete remains persistent-only and soft-deletes with `deprovisioned_at`. The session owner additionally gets bulk pause/resume/stop over persistent agents plus workers; Concierge is excluded. An idle manually paused worker stays active and visible while Auto agents is enabled. Disabling Auto agents clears worker `paused_at` and retires idle generated rows so later reuse cannot reactivate an unreachable paused worker.
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

#### `session_files`

- Files members share into the session (ENG-113), from the team-chat composer, the prompt composer, or the Team panel's Artifacts view. Bytes live in R2 (`PREFLIGHT_LOGS`, key `sessions/{sessionId}/files/{id}` via `lib/session-files.ts`); the row is the authority for existence and authorization, the same D1-first contract as avatars.
- `message_id` set = attached to the team-chat message that claimed it (only the uploader's own still-unclaimed rows can be claimed, in the same batch as the message insert); null = a plain artifact. `ON DELETE SET NULL` keeps the artifact listed if its message ever goes away. Attachments are refused on DMs — a DM attachment would surface in the session-wide artifacts list and leak the private exchange.
- Uploads are member-writes capped by `lib/session-file-constraints.ts` (8 files/8MB each per request, sanitized single-line names); any content type is accepted, and safety lives at serve time: `GET /api/sessions/[id]/files/[fileId]` sends `x-content-type-options: nosniff` and serves only image types inline, everything else as `content-disposition: attachment`, so an uploaded HTML/SVG can never script the app origin.
- Every run's sandbox receives the current shared files (bounded by `getSessionSharedFiles`, 20 rows) copied to `/workspace/attachments/<id8>-<name>` — outside the repository worktree so they can never surface as changed paths — and the brief's "Files the team shared" section lists those exact paths. Realtime rides the existing `messages` floor domain; no new DO event type.

#### `floor_queue_items`

- Ordered by integer `position` within a session.
- Nullable agent target represents an unassigned prompt.
- Status is `queued`, `running`, `blocked`, `completed`, `paused`, `failed`, or `cancelled`. Only queued items can be merged or started.
- Agent foreign key uses `ON DELETE SET NULL` for future lifecycle support, although deletion is not exposed today.
- `intent` (nullable, TS-only open enum `task`/`question`/`noise`, no SQL CHECK) is set once by `db/routing.ts`'s `classifyPrompt` — a pure lexical function (whole-string greeting/acknowledgement match, then an actionable-verb check across the whole string, then a trailing-`?` check, then a check of the first content word (after skipping leading interjections like "yo"/"ok"/"so") against interrogatives and answer-shaped imperatives ("describe"/"explain"/"summarize"), defaulting to `task`) run at the same routing tick that assigns the item, whether or not that tick reassigns its agent. `null` means classified before this column existed, or not yet visited by a tick; treat as `task`. This is intentionally not a model call: it evolves the existing keyword-overlap router rather than adding a second classification system, and is expected to be replaced by something semantic later without touching persistence, dispatch, or the UI, since the intent lives on the row already.
- `origin` (nullable, TS-only open enum `ci_failure`/`review_comments`/`changes_requested`, migration `0041`) marks a system-originated PR feedback nudge (`lib/candidate-feedback.ts`); null for every human-authored item. Its prompt row is attributed to the session owner (the resolver-run `created_by` convention — `floor_queue_prompts.author_user_id` stays NOT NULL), `intent` is pinned to `task` so a comment ending in "?" never routes to the Concierge, and the brief renders its prompt up to 3,000 characters instead of the ordinary 300. `source_run_id` (nullable soft reference, migration `0040`) names the run the nudge follows up on; `createAgentRun` resumes that run's provider thread when the same agent picks the item up.
- `dismissed_at` (nullable, migration `0027_workable_wild_pack.sql`) marks a soft delete. `agent_runs.queue_item_id` has no `ON DELETE` action (unlike the agent FK above), and `agent_runs` already carries four inbound `ON DELETE CASCADE` foreign keys — adding a fifth would force the same dangerous table recreate discussed under `sessions` above. A `failed`/`cancelled` item always has a run row, so `DELETE /api/sessions/[id]/queue/[queueItemId]` (`db/floor.ts`'s `deleteFloorQueueItem`) instead sets `dismissed_at` and repositions the remaining live items; the run row, its events, checks, files, and artifacts are untouched. Every queue read and mutation guard (`db/floor.ts`, `db/routing.ts`, `db/session-context.ts`) filters `dismissed_at IS NULL`. Before this fix, the hard `DELETE` raised an unhandled `FOREIGN KEY constraint failed`, which the client's generic error handling misreported as "The floor could not be reached" — see `components/session/usePersistentFloorData.ts`'s `request`, which now also distinguishes a parseable server-error JSON body from a genuine network failure so a future unhandled error reports its real HTTP status instead of reusing that same message.

#### `floor_queue_prompts`

- A queue item contains one or more authored prompts.
- Merging moves prompts into the surviving same-target item, preserving every prompt, author, and creation time.
- Ordering mutations submit the exact set of current item IDs. A stale or incomplete order returns a conflict instead of silently dropping records.

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
- `runs`
- `review`

`FloorSnapshot` includes `autoDispatch`, `autoProvisionAgents`, configured/effective generated-agent provider state, `autoResolveConflicts`, nullable `repository`, `activeCandidate`, bounded `latestPreflight`, active agents, and the latest 20 caller-visible runs. Every queue item independently derives its caller-specific integrated-run rollback descriptor, so Queue rollback state is complete even when the run is older than that 20-run window. Runs derive `purpose` (`task` or `conflict_resolution`), nullable `conflictCaseId`, and their latest bounded rollback state. Large logs and artifacts are fetched separately. `review` is null until real repository/run data exists, then includes typed conflict cases/questions and candidate-wide attribution from dedicated queries rather than the latest-run window; never populate it from UI fixtures.

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
| `PATCH /api/account/onboarding` | Authenticated user | Save pending profile/avatar before the required GitHub redirect without setting `onboarded_at`. |
| `POST /api/account/onboarding` | Authenticated user with active GitHub installation | `multipart/form-data` `{ firstName?, lastName?, githubHandle?, plan?, quantity?, returnTo }`. A valid signed-invite return forces Free and completes onboarding. Direct Free completes onboarding; direct Pro/Max returns a Stripe Checkout URL. Missing GitHub access is `409`; missing/invalid direct plan is `400`. |
| `GET /api/account/github` | Authenticated user | List the caller's GitHub installation summaries; never returns raw installation authority. |
| `GET /api/account/github/repositories` | Authenticated user | Aggregate and deduplicate repositories across active installations. Each option carries an opaque account-installation association ID. |
| `POST /api/account/github/connect` | Authenticated user | Create a signed 30-minute single-use state for `{ purpose: "onboarding" \| "settings", returnTo? }` and return the GitHub App installation URL. |
| `DELETE /api/account/github/installations/[installationId]` | Authenticated user | Delete one caller-owned association from future repository selection. Existing session connections are unchanged. |
| `PATCH /api/account/profile` | Authenticated user | `multipart/form-data` `{ firstName, lastName, githubHandle?, avatar?, removeAvatar? }`; account-settings profile edit. `avatar` and `removeAvatar` are mutually exclusive (`400` if both are sent); omitting both keeps the existing picture. Never touches `onboarded_at`. Returns `{ user }`. |
| `PATCH /api/account/settings` | Authenticated user | Update `{ doNotDisturb: boolean }`. |
| `GET /api/account/avatar/[userId]` | Authenticated user | Stream the target user's avatar from R2, or `404` if none is set; `cache-control: private, max-age=300`. |
| `DELETE /api/account` | Authenticated user | Body `{ confirm: "DELETE", deleteBranches?: boolean }` (`400` without `confirm`). Checks only for an in-progress GitHub integration on an owned session, cancels known Stripe subscriptions immediately without refund, best-effort abandons any owned sessions' live candidates (attempting a lease-verified GitHub branch delete for up to 3 when `deleteBranches` is true), rechecks the integration blocker, then scrubs/releases the account. `409 { code: "sessions_blocked", sessions }` only for an in-progress integration; `502` when Stripe cancellation fails and the account remains intact; success returns `{ deleted: true, orphanedBranches: string[] }`. |
| `POST /api/billing/checkout` | Onboarded authenticated user | Validate `{ plan: "pro" \| "max", quantity, returnTo? }`, bind Checkout to the internal user ID, and return `{ url }`. Refuses duplicate non-terminal subscriptions, active Enterprise, invalid quantities, mismatched configured prices, or a disabled rollout gate. |
| `POST /api/billing/change` | Authenticated user with Stripe subscription | Validate the requested Pro/Max plan and quantity, then return a Customer Portal confirmation deep-link for an immediate prorated update. |
| `POST /api/billing/portal` | Authenticated user | Return a Customer Portal URL for the account-bound Stripe customer. Portal configuration owns immediate cancellation and the allowed products/proration contract. |
| `GET /api/billing/checkout/return` | Authenticated Checkout owner | Retrieve the bounded Checkout session ID, verify its internal user binding and paid subscription, reconcile current Stripe state, then redirect to the safe app return path. |
| `GET /api/account/credentials` | Authenticated user | List the caller's provider-credential summaries (provider, kind, last-four fingerprint, validation time). Never returns a stored value. |
| `PUT /api/account/credentials/[provider]` | Authenticated user | Body: exactly one of `{ apiKey }` (kind `api_key`, ≤512-char opaque token, validated against the provider's models endpoint), `{ setupToken }` (kind `oauth`, same token rules; anthropic setup tokens validate against `GET /v1/models` with a plain Bearer, while a kimi plan key stores `validated_at = null` — no verified probe exists), or `{ authJson }` (kind `oauth`, ≤8192-char JSON bundle shape-checked for `tokens.account_id`/`access_token`; accepted for `openai`, stored verbatim with `validated_at = null` since no free probe exists, and fingerprinted by `account_id`). Encrypts and upserts per `(provider, kind)`. `404` unknown provider, `400` invalid input, provider-rejected key, or a kind the provider does not accept, `502` provider unreachable. Returns `{ credential }` (summary only — write-only contract). |
| `DELETE /api/account/credentials/[provider]` | Authenticated user | Disconnect the caller's credential for that provider; `?kind=` picks the row (default `api_key` for back-compat; `404` for a kind the provider does not accept); `204`. |
| `POST /api/sessions` | Onboarded authenticated user with active GitHub installation | Create `{ title, objective?, accountInstallationId, repositoryId }`. Server resolves caller ownership, revalidates repository/default branch/head, atomically creates session/invite/repository/candidate reservation, then provisions candidate. Returns `setupStatus: "ready"` or recoverable `"failed"`; pre-write access failures create no session. |
| `PATCH /api/sessions/[id]` | Session member | Update `{ objective: string \| null }`; broadcasts `session.changed`. |
| `GET /api/sessions/[id]/members` | Session member | Return authorized roster. |
| `GET /api/sessions/[id]/invite` | Owner | Return active reusable signed link or null. |
| `POST /api/sessions/[id]/invite` | Owner | Rotate/create link; old link becomes invalid. |
| `DELETE /api/sessions/[id]/invite` | Owner | Revoke active link. |
| `POST /api/invites/[token]/accept` | Authenticated user | Idempotently add member and broadcast `members.changed`. |
| `DELETE /api/sessions/[id]/membership` | Non-owner member | Leave, disconnect presence, and notify roster. |
| `POST /api/sessions/[id]/end` | Owner | Idempotently set `ended_at`, revoke the active invite, and broadcast `session.ended`. |
| `DELETE /api/sessions/[id]` | Owner | Optional body `{ candidate?: "delete-branch" \| "orphan" }`. Hard-deletes the session; children cascade. A live, unabandoned candidate and no `candidate` choice returns `409 { code: "candidate_live", branch, canDeleteBranch }` instead of refusing outright (ENG-83) — the owner picks a choice and retries, which abandons the candidate (optionally deleting its branch on GitHub) before deleting. `409` still refuses while a run holds the candidate's integration lease. Success broadcasts `members.changed` so open tabs refetch, hit the 404 concealment, and return to `/home`; `200 { deleted: true, warning }` when a merged or abandoned candidate's branch survives on GitHub, else `204`. |
| `GET /api/sessions/[id]/floor` | Session member | Return the caller-specific authoritative `FloorSnapshot`. |
| `POST /api/sessions/[id]/agents` | Session member | Create `{ name, role, task, ownerUserId, provider?, credentialKind?, model? }` (provider defaults to `openai`; a rollout-gated provider returns `503`; `credentialKind` must be among `credentialKindsForProvider(provider)` and `model` among `PROVIDER_MODELS[provider]`, else `400`). |
| `PATCH /api/sessions/[id]/agents/[agentId]` | Session member | Persist a partial `{ task?, model?, credentialKind? }` (at least one key) on a persistent (`kind IS NULL`), non-deleted agent. Omitted = leave alone; explicit `null` resets `model`/`credentialKind` to the default. `model`/`credentialKind` validate against the agent's **stored** provider — the body carries none. A `credentialKind` change returns `409` while the agent has a run in `AGENT_ACTIVE_RUN_STATUSES` (the gateway resolves billing live per request; a mid-run change would silently switch payer); a `model` change needs no such guard (frozen into `agent_runs.model` at run creation). |
| `DELETE /api/sessions/[id]/agents/[agentId]` | Session member | Soft-delete a persistent agent (`db/floor.ts`'s `deleteFloorAgent`); unassigns it from `queued`/`paused` items. `409` while it has a real in-flight run. |
| `PATCH /api/sessions/[id]/agents/[agentId]/pause` | Session member | `{ paused: boolean }` for a persistent agent or generated worker. Blocks/allows new router dispatch; never touches an in-flight run. Concierge is rejected. |
| `POST /api/sessions/[id]/agents/[agentId]/stop` | Session member | For a persistent agent or generated worker, always blocks new dispatch; cancels the active run only when the caller is the owner. Concierge is rejected. |
| `POST /api/sessions/[id]/agents/pause-all` | Owner | Pause every active persistent agent and generated worker; exclude Concierge. |
| `POST /api/sessions/[id]/agents/resume-all` | Owner | Resume every paused persistent agent and generated worker; exclude Concierge. |
| `POST /api/sessions/[id]/agents/stop-all` | Owner | Pause every persistent agent and generated worker and cancel every active run they have; exclude Concierge. |
| `PATCH /api/sessions/[id]/assignments/[memberId]` | Session member | Persist `{ task: string \| null }`. |
| `POST /api/sessions/[id]/messages` | Session member | Persist `{ text, recipientUserId?, attachmentIds? }`. Attachment ids claim the caller's own still-unclaimed `session_files` rows for the new message; refused (`400`) with a recipient. |
| `POST /api/sessions/[id]/files` | Active session member | `multipart/form-data` `files` (1–8, ≤8MB each). Bytes to R2, rows to `session_files`, returns `{ floor, fileIds }` (`201`). |
| `GET /api/sessions/[id]/files/[fileId]` | Session member | Stream one shared file; image types inline, everything else `attachment`, always `nosniff`; non-members and unknown files share the same `404`. |
| `POST /api/sessions/[id]/queue` | Session member | Persist `{ prompt, agentId? }`; null target is valid. |
| `PATCH /api/sessions/[id]/queue/order` | Session member | Persist an exact unique `{ itemIds }` order. |
| `POST /api/sessions/[id]/queue/merge` | Session member | Merge at least two existing same-target items, preserving prompts. |
| `PATCH /api/sessions/[id]/queue/[queueItemId]` | Owner, or the item's sole author | Target an unassigned `queued` item with `{ agentId }` (`db/floor.ts`'s `setFloorQueueItemAgent`). Closes the dead end an "Auto"-targeted prompt hits while `auto_dispatch` is off, when the router's assign phase — the only other assigner — never runs. |
| `DELETE /api/sessions/[id]/queue/[queueItemId]` | Owner, or the item's sole author | Soft-delete (`dismissed_at`) a `queued`/`paused`/`failed`/`cancelled` item and reposition the remaining live ones; see `floor_queue_items.dismissed_at` above. |
| `PATCH /api/sessions/[id]/routing` | Owner | Update any of `{ autoDispatch?, autoProvisionAgents?, autoAgentProvider?, autoResolveConflicts?, autoInjectFeedback? }`; omitted settings are preserved. Provider selection must be connected and rollout-enabled. Provisioning depends on ordinary auto-dispatch; conflict automation and PR feedback nudges remain independent. |
| `POST /api/sessions/[id]/conflicts/[caseId]/resolve` | Owner | Manually start or retry one same-session conflict case. Cross-session IDs are concealed; ended sessions return `409`. |
| `POST /api/sessions/[id]/conflicts/[caseId]/answers` | Session owner or current original prompt author | Submit one required answer per exact current unanswered question. Unrelated active members and outsiders receive concealed `404`; first complete submission wins; stale/mismatched authorized races return `409`. |
| `GET /api/sessions/[id]/conflicts/[caseId]/snapshot` | Session owner or current original prompt author | The case's current resolver attempt's conflict snapshot, parsed into per-file hunks plus any selections already recorded against it. Concealed `404` when unauthorized; ordinary `404` before any attempt has captured one. |
| `POST /api/sessions/[id]/conflicts/[caseId]/selections` | Session owner or current original prompt author | Submit one `ours`/`theirs`/`both` choice for every hunk in the case's current snapshot (`{ snapshotRunId, selections }`). `400` on an incomplete or unknown set, `409` when `snapshotRunId` is no longer current, concealed `404` when unauthorized. |
| `GET /api/sessions/[id]/skills` | Session member | List imported Claude-skill summaries (name, description, size, updated); never content. |
| `POST /api/sessions/[id]/skills` | Owner | Import `{ content }` as a validated `SKILL.md`; upserts by frontmatter name. `400` malformed, `409` at the 20-skill cap or on an ended session. |
| `DELETE /api/sessions/[id]/skills/[skillId]` | Owner | Remove one imported skill; returns the updated list. |
| `GET /api/sessions/[id]/mcp-servers` | Session member | List configured MCP-server summaries (name, transport, url, header names, enabled); never header values. |
| `POST /api/sessions/[id]/mcp-servers` | Owner | Add `{ name, transport, url, headers?, enabled? }`. `400` invalid or reserved name, `409` duplicate name, at the 10-server cap, or on an ended session. |
| `PATCH /api/sessions/[id]/mcp-servers/[serverId]` | Owner | Update any of `{ transport, url, headers, enabled }`; omitted headers keep, `null` clears. |
| `DELETE /api/sessions/[id]/mcp-servers/[serverId]` | Owner | Remove one server; returns the updated list. |
| `GET /api/sessions/[id]/presence` with Upgrade | Session member | Authenticated WebSocket handoff to the per-session Durable Object. |
| `POST /api/sessions/[id]/repository/connect` | Owner | Retired rollback-safe boundary; returns `410` with Account Settings guidance and creates no session-bound state. |
| `GET /api/github/callback` | Authenticated initiating user | Verify installation belongs to configured App, consume account state once, upsert association, and return to onboarding or Settings. |
| `GET /api/sessions/[id]/repository` | Session member | Return the durable repository connection, or null. |
| `GET /api/sessions/[id]/repository/options` | Owner | For legacy/disconnected sessions, list account-authorized repositories; for connected sessions, list only current repository and branches. |
| `POST /api/sessions/[id]/repository` | Owner | Resolve opaque account installation/repository, persist default branch, then provision candidate automatically. |
| `PATCH /api/sessions/[id]/repository` | Owner | Change the base branch for the same connected repository. |
| `DELETE /api/sessions/[id]/repository` | Owner | Mark the connection disconnected without mutating GitHub. |
| `POST /api/sessions/[id]/repository/candidate` | Owner | Retry failed candidate provisioning. Reconcile exact recorded branch/SHA first; preserve mismatches and create a new recorded attempt when exact recovery is impossible. |
| `DELETE /api/sessions/[id]/repository/candidate` | Owner | Abandon the session's live candidate (see `repository_candidates.abandonedAt`) without merging, freeing the one-live-candidate slot for a fresh cycle. Body `{ deleteBranch?: boolean }`; when true, attempts a lease-verified GitHub branch delete the same way the post-merge branch-delete route does. Retryable: calling again on an already-abandoned candidate whose branch didn't verify-delete the first time retries only that part. `409 { runId }` under the candidate's integration lease; `409` when there is no live candidate; success returns `{ floor }`, plus `warning` when the branch survives on GitHub. |
| `POST /api/sessions/[id]/repository/sync` | Owner | Reconcile repository metadata and base/candidate heads without modifying GitHub. `403 { code: "quota_exhausted" }` at the owner's spent quota. |
| `GET /api/sessions/[id]/repository/preflight` | Session member | Return the latest bounded preflight/check state. Dark behind `PREFLIGHT_ENABLED = false` this release. |
| `POST /api/sessions/[id]/repository/preflight` | Owner | Start one durable preflight for the exact active candidate; requires at least one command. Dark behind `PREFLIGHT_ENABLED = false` this release. `403 { code: "quota_exhausted" }` at the owner's spent quota. |
| `GET /api/sessions/[id]/repository/preflight/[preflightId]/logs` | Session member | Stream the caller-authorized bounded command logs from private R2. |
| `GET /api/sessions/[id]/repository/tree` | Session member | List the connected repository's file tree (bounded to 10,000 entries) at the active candidate's head SHA, falling back to the connection's base branch; no candidate required, no quota gate. |
| `GET /api/sessions/[id]/repository/file` | Session member | Read one file's content (`?path=`) at the same ref the tree used; bounded to 512 KB and 5,000 lines, reporting `binary`/`too_large` rather than decoding past the cap. |
| `GET /runtime/preflight/source` | Short-lived source JWT | Proxy the exact candidate archive without exposing a GitHub installation token to the Sandbox process. |
| `POST /api/sessions/[id]/queue/[queueItemId]/run` | Owner | Start a durable Codex run for an assigned queued item at the exact active candidate SHA. `403 { code: "quota_exhausted" }` at the owner's spent quota (also gates `worker/session-router.ts`'s auto-dispatch, the only other place a run starts). |
| `POST /api/sessions/[id]/runs/[runId]/cancel` | Owner | Request cancellation of an active run. |
| `POST /api/sessions/[id]/runs/[runId]/discard` | Owner | Delete only an unchanged, verified openfloor run branch using an expected-SHA lease; retain audit history. |
| `POST /api/sessions/[id]/runs/[runId]/rollback` | Owner, run agent owner, or every-prompt author | Request a durable inverse commit for one integrated run against the still-open unchanged candidate. The expected-SHA push advances the candidate while retaining the run audit. |
| `POST /api/sessions/[id]/runs/[runId]/retry` | Owner | Retry a conflicted queue item as a new run attempt pinned to the latest candidate SHA. `403 { code: "quota_exhausted" }` at the owner's spent quota. |
| `GET /api/sessions/[id]/review/contributions` | Session member | Page current-candidate prompt groups newest-first (default 25, maximum 100), with Active/History plus file, engineer, and agent filters and active contributor facets. |
| `GET /api/sessions/[id]/review/contributions/[runId]` | Session member | Return one current-candidate prompt group and its bounded original historical per-run file diffs. |
| `GET /api/sessions/[id]/review/rollback-impact` | Authorized single caller; owner for bulk | Resolve the exact current candidate SHA, target run set, files/contributors, and mixed-author exclusions for prompt, engineer, or agent scope. |
| `POST /api/sessions/[id]/review/rollbacks` | Authorized single caller; owner for bulk | Revalidate the previewed candidate SHA and exact ordered run set, then start one atomic rollback group. |
| `POST /api/sessions/[id]/review/ready` | Owner | Reconcile the exact active PR and use GitHub's ready-for-review mutation; preserve 404 concealment. |
| `POST /api/sessions/[id]/review/draft` | Owner | Reconcile the exact active PR and use GitHub's `convertPullRequestToDraft` mutation to return it to a draft; the first-ready audit columns are preserved. Same 404 concealment and 409 ended-session contract as `review/ready`. |
| `POST /api/sessions/[id]/review/sync` | Session member | Reconcile the exact active PR files, checks, and mergeability into D1 without changing draft status; broadcasts `floor.changed` with `review` domain. Same 404 concealment and 409 ended-session contract. |
| `POST /api/sessions/[id]/review/merge` | Owner | Reconcile head/base/files/checks/mergeability, request an exact-head squash merge, confirm it, and safely clean matching openfloor refs. |
| `GET /api/sessions/[id]/runs/[runId]/artifacts` | Session member | Return caller-authorized bounded run artifacts from private R2; unfiltered defaults to `codex_log` + `diff` (unchanged), `?kind=` returns exactly one artifact (e.g. `prompt`). |
| `GET /api/sessions/[id]/runs/[runId]/events` | Session member | Return one run's persisted activity timeline incrementally via `?after=<sequence>`. |
| `POST /runtime/run/events` | Short-lived run events JWT | Ingest bounded, runner-sequenced activity events for one active run and broadcast them as `run.activity`. |
| `GET /runtime/run/source` | Short-lived run source JWT | Proxy the exact candidate archive for one run. |
| `GET /runtime/run/context` | Short-lived run context JWT | Re-render the same session brief the run was dispatched with, from current D1 state; called by the `openfloor_session_context` MCP tool the sandbox exposes to Codex so a long run can re-read the floor mid-run. |
| `GET /runtime/run/conflict-source?part=base\|bundle` | Short-lived conflict-source JWT | Serve only a resolver run's bound source candidate archive or retained verified bundle after checking run/session/repository/candidate/case relationships. |
| `POST /runtime/run/conflict-input` | Short-lived conflict-input JWT | Accept a resolver-only bounded explanation and one to three questions from `openfloor_request_conflict_input`, persist them, notify clients, and stop the workflow without publishing partial work. |
| `POST/GET /runtime/run/bundle` | Short-lived operation JWT | Store an agent-exported bounded Git bundle and serve it only to the clean trusted publisher. |
| `POST /runtime/openai/v1/responses` | Short-lived run OpenAI JWT (90-minute TTL, longer than the 60-minute run step so a full-length run cannot outlive its own credential) | Forward one active run's Codex request, injecting the agent owner's connected OpenAI credential when present, else the server key, outside the repository process. An `api_key` resolution goes to `https://api.openai.com/v1/responses` as `authorization: Bearer`; an `oauth` (ChatGPT subscription) resolution sends **only** the bundle's `tokens.access_token` plus a gateway-injected `chatgpt-account-id` to `https://chatgpt.com/backend-api/codex/responses` — never the stored bundle, never the refresh token — refreshing the bundle server-side first when it nears expiry. `content-encoding` is forwarded because the CLI sends zstd bodies. `503` with a clear message when neither credential exists, the owner's cannot be decrypted, or a stored bundle no longer parses — never a silent fallback. Any other path is logged with its provider prefix and concealed; `GET /v1/models` is deliberately not allowlisted (the shipped posture never calls it). |
| `POST /runtime/anthropic/v1/messages` (+ `/count_tokens`) | Short-lived run Anthropic JWT | Forward one Claude run's model request with the same owner-else-server-else-`503` resolution, translating the run JWT to the resolved credential's native upstream auth: `x-api-key` for `api_key`, `authorization: Bearer` + merged `anthropic-beta: oauth-2025-04-20` for a subscription setup token (shared handler: `lib/anthropic-compat-gateway.ts`; also forwards `retry-after` and `anthropic-ratelimit-*` back to the run). Any other path is logged and concealed so the allowlist is finalized from observed traffic. |
| `POST /runtime/kimi/v1/messages` (+ `/count_tokens`) | Short-lived run Kimi JWT | Same shared Anthropic-compat handler against `https://api.moonshot.ai/anthropic/v1`, injecting the resolved Moonshot key as `authorization: Bearer` (Spike-A-verified). An `oauth`-kind resolution (a Kimi Code plan key) instead goes to `https://api.kimi.com/coding/v1` with the key as `x-api-key` — the handler's `oauthUpstreamBase`, on the vendor's documented plan surface (2026-08-26 decision entry). `count_tokens` stays allowlisted even though Moonshot 404s it — the CLI degrades on the vendor's answer, not on concealment. |
| `POST /runtime/glm/v1/messages` (+ `/count_tokens`) | Short-lived run GLM JWT | Same shared Anthropic-compat handler against `https://api.z.ai/api/anthropic/v1`, injecting the resolved Z.ai key as `authorization: Bearer` (Spike-A-verified, funded-account rerun). Unlike Moonshot, Z.ai answers `count_tokens` with a real 200. Any other path is logged and concealed. |
| `POST /runtime/gemini/v1beta/models/<model>:<verb>` | Short-lived run Gemini JWT (`x-goog-api-key`, Bearer fallback) | Standalone route (deliberately not the Anthropic-compat helper) against `https://generativelanguage.googleapis.com`: verbs `generateContent`/`streamGenerateContent`/`countTokens`, the query string forwarded filtered to `alt` (`?alt=sse` is how the CLI streams), the resolved Google key injected as `x-goog-api-key`. Any other path is logged and concealed. |
| `POST /runtime/qwen/v1/chat/completions` | Short-lived run Qwen JWT | OpenAI-chat-compat handler (`lib/openai-chat-compat-gateway.ts` — the Anthropic-compat handler's contract for the chat-completions wire: operation-bound JWT, run-status re-check, 10 MB cap, path allowlist, owner-else-server-else-`503`, SSE passthrough) against `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, injecting the resolved Alibaba Cloud key as `authorization: Bearer` and forwarding `retry-after` plus `x-ratelimit-*` back to the run. The pinned Qwen Code CLI sends exactly this one path (Spike Q1, 2026-08-28) — it never lists models — so `GET /models` and every other path is logged and concealed. |
| `POST /runtime/deepseek/v1/chat/completions` | Short-lived run DeepSeek JWT | The same handler against `https://api.deepseek.com`, injecting the resolved DeepSeek key as `authorization: Bearer` — the qwen route with a different upstream, secret, and operation (the Kimi→GLM recipe). Any other path is logged and concealed. |
| `POST /webhooks/github` | Valid GitHub HMAC | Deduplicate and process bounded installation, access, repository, push, PR, check, status, and PR-review deliveries; qualifying check/status/review deliveries on the candidate PR re-observe GitHub and may queue PR feedback nudges. |
| `POST /webhooks/stripe` | Valid Stripe signature | Cap the raw body at 256 KB; deduplicate and reconcile supported Checkout, subscription, and invoice lifecycle deliveries into D1 entitlement. Invalid signature is `401`; reconciliation failure is `500` so Stripe retries. |

Response conventions:

- `401` means no authenticated identity.
- `400` means invalid input or a cross-session/invalid target.
- `404` conceals nonexistent sessions, non-membership, unauthorized owner-only resources, invalid invites, and revoked invites.
- `409` represents conflicts such as duplicate normalized agent name, stale queue order, stale conflict answers, owner leave, or any mutation on an ended session ("This session has ended."). `DELETE /api/account` returns `409 { code: "sessions_blocked", sessions }` when an owned session has live repository state (same class of conflict as `DELETE /api/sessions/[id]`'s `repository_state`/`integration_in_progress`), and writes nothing in that case.
- `403` with `{ code: "quota_exhausted" }` marks the session owner's monthly session-hours quota as spent — see "Plan limits and metering" below. `acceptInvite`'s seat-cap refusal returns `403` too, but without a machine-readable `code` today.
- Floor mutations return `{ floor }`; clients treat it as authoritative.

### Validation limits

Keep server validation in `lib/validation.ts` and cover it with unit tests.

- Profile first/last name (`parseProfileInput`, shared by onboarding and account settings): required, NFKC-normalized, whitespace-collapsed, maximum 50 characters each. GitHub handle: optional, trimmed, empty becomes null, maximum 39 characters.
- Avatar upload (`lib/account-avatar.ts`, shared by onboarding and account settings): PNG/JPEG/WebP only, maximum 5MB.
- Session title: required, trimmed, maximum 100 characters.
- Objective: nullable, trimmed, empty becomes null, maximum 2,000.
- Agent name: required, NFKC-normalized, whitespace-collapsed, maximum 24. Agent provider: optional, any known provider id, defaults to `openai`. Agent credentialKind: optional, must be a kind `credentialKindsForProvider` allows for the resolved provider; omitted/null means the owner's default. Agent model: optional, must be in `PROVIDER_MODELS` for the agent's provider; omitted/null means the provider's default. Agent settings patch (`parseAgentSettingsInput`): partial `{ task?, model?, credentialKind? }` with at least one key; task keeps the exact create rules; absent and explicit null stay distinguishable for `model`/`credentialKind`.
- Agent role: required, trimmed, maximum 80.
- Agent task: required, trimmed, maximum 1,000.
- Assignment: nullable, trimmed, empty becomes null, maximum 2,000.
- Message: required, trimmed, maximum 4,000.
- Queue prompt: required, trimmed, maximum 4,000.
- Queue order/merge ID list: unique strings, maximum 500 items; merge requires at least two.
- Conflict input request: explanation required and at most 4,000 characters; one to three required questions, each at most 500 characters.
- Conflict answers: one to three unique question IDs, each at most 100 characters; every answer required and at most 2,000 characters. Domain logic additionally requires the exact current unanswered set.
- Live draft: maximum 4,000, not trimmed because it represents in-progress text.
- Repository selection: repository ID maximum 100 characters; base branch required and maximum 255 characters.
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

The free plan's 2h/month allowance is spent once per **email address**, not once per account row. `lib/plans.ts`'s `planHourLimit(plan, freeAllowanceUsed)` returns `0` in place of the free tier's 2h when `users.free_allowance_used_at` is set — set only by `upsertUser` recognizing that the new account's email matches a `prior_email_hash` some deleted account's tombstone left behind (see the `users` table entry above and `lib/account-email-hash.ts`). Every hour-quota read site (`getOwnerHourQuota`, `getUsageForUser`) goes through `planHourLimit`; nothing indexes `PLAN_LIMITS` by hand for an actual enforcement decision — `PLAN_LIMITS` itself stays the static catalog `planLimitsSummary` and this table describe. Seats are unaffected — see the `users` table entry's rationale.

### Enforcement points — spend initiators only

Deliberately **not** folded into `getActiveMembershipRole` (Persistence model, above): that function backs 22 call sites, and gating all of them at quota would strand an out-of-hours owner unable to revoke a leaked invite, turn auto-dispatch off, disconnect a repository, pause/delete a queue item, discard a run branch, or land already-completed work through review/merge — the wind-down set an owner must always retain, listed in full below. It would also throw into `worker/session-router.ts`'s bare `catch`, driving a permanent 60-second alarm retry loop for a condition (out of hours) that does not resolve until the month rolls over.

Instead, the quota gate sits at exactly four points, all "this is about to spend money or occupy a paid seat":

1. **`acceptInvite`** (`db/sessions.ts`) — seat cap only. One gate query; re-accepting as an already-existing member stays idempotent past the cap (`// ponytail:` comment documents the accepted check-then-insert race).
2. **The presence WebSocket upgrade** (`worker/presence.ts`'s `handlePresenceRequest`) — hour quota. Ended sessions are never gated (or metered); live sessions past quota get an accept-then-close with WebSocket code `4003`, with distinct close-reason text when the limit itself is `0` (a spent free allowance) versus an ordinary paid-plan quota exhaustion. Already-connected sockets are never kicked — the DO's booked total lags real usage by at most one `USAGE_FLUSH_INTERVAL_MS` (15 min).
3. **`startQueueItemRun`** (`lib/agent-run-start.ts`) — hour quota, returned as a `StartRunResult` union variant (`{ ok: false, kind: "quota_exhausted" }`), not thrown. This is the single seam covering both HTTP routes (`.../queue/[queueItemId]/run`, `.../runs/[runId]/retry`) *and* `worker/session-router.ts`'s auto-dispatch path, which has no HTTP layer to gate at all. `db/routing.ts` already treats any non-`"conflict"` failure kind as a session-wide precondition and holds with exponential backoff (`HELD_RETRY_BASE_MS` doubling up to `HELD_RETRY_MAX_MS`) — returning the variant gets correct backoff for free; throwing would not.
4. **Repository preflight and sync** (`lib/floor-api.ts`'s `quotaExhaustedErrorResponse`, called from both routes after `activeOwnerErrorResponse`) — hour quota. Unlike (3), a null `getOwnerHourQuota` result here fails closed (throws) rather than falling through, because `activeOwnerErrorResponse` has already confirmed the session and owner exist — a null result at that point is an invariant violation, not the ordinary shape of "unknown session" the way it is in `startQueueItemRun` (which runs before any such check). Returns `403 { code: "free_allowance_used" }` instead of `403 { code: "quota_exhausted" }` when the limit itself is `0`.

**Never gated — the wind-down set.** An owner past quota must always be able to: read anything, send chat, edit/pause/delete queue items, cancel a run, revoke an invite, turn auto-dispatch off, disconnect a repository, discard a run branch, roll back an integrated prompt, mark review ready, merge, end, leave, archive, and delete. None of these call the quota helpers; keep it that way.

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
- `SessionScreen` owns the lobby’s current repository/candidate presentation so `RepositoryCard` mutation results immediately update setup status and floor entry. `ProviderCredentials` is the shared write-only credential UI used by Settings, the lobby's `ModelConnectionCard`, and `HomeScreen`'s `CreateSessionDialog` AI-connection step.
- The Agent Floor receives the first `FloorSnapshot` from the server to avoid a loading-only shell.
- `usePersistentFloorData` is the asynchronous data-source boundary for floor reads and writes.
- A mutation response updates local state immediately; a newer remote floor revision triggers a refetch.

### Agent Floor structure

- `Workspace.tsx`: orchestration, local layout state, reload-safe conflict attention banner, exact-case Review navigation, and hidden-tab browser-notification coordination.
- `TopBar.tsx`: workspace/review navigation and conflict-attention badge, real member presence, owner invite dialog, settings, sign-out.
- `ObjectiveBar.tsx`: persistent member-editable objective; an owner-only nudge banner opens the same editor once public chat has outpaced the objective's last edit.
- `BriefRail.tsx`: real members, assignments, team chat, and DMs; it does not expose repository rollback actions.
- `AgentFloor.tsx` and `AgentCard.tsx`: empty state, creation dialog, and persisted agent metadata only; agent cards and spotlight do not expose repository rollback actions.
- `PromptQueue.tsx`: real queue filtering, ordering, merging, targeting, prompts, “Merge Resolver” run labeling, and authorized per-prompt rollback state/actions.
- `QueueOrderMenu.tsx`: owner-only ordinary/conflict/PR-feedback automation settings plus the per-device, explicit-permission browser conflict-alert control.
- `FloorDock.tsx`: queue composer, target selection, live teammate drafts, and draft visibility controls.
- `ReviewScreen.tsx`: consumes nullable authoritative review data and provides top-level `Files` / `Prompts` modes. Files retains `Changed` / `All files` browsing and shows collapsible prompt/engineer/software-agent contribution cards above changed-file diffs. Prompts pages Active or History groups, shows each group's full prompts and exact historical run diff, filters by contributor, and exposes owner-only engineer/agent bulk removal. Its three columns are drag-resizable like the workspace's (CSS-variable grid columns, 250–560px clamp, stacked under 900px). Conflicts never render as an inline list — the hero's **Conflicts** button carries the attention state (amber while the resolver works, red and breathing when a person must act) and opens `ConflictCenterDialog`, and the `selectedConflictCaseId` deep-link prop is a one-shot signal that opens the same popup focused on that case. It keeps an honest empty state when no review exists.
- `ConflictCenterDialog.tsx`: the single popup home for merge conflicts. A rail lists cases open-first with clamped prompt previews; the guided case view shows what happened, every resolver attempt, answer forms only for the session owner/current original prompt authors, waiting text for other members, owner-only retry controls, and a "Resolve manually" step (same owner-or-prompt-author gate, requires `hasSnapshot`) that embeds the per-hunk editor in place rather than stacking a second dialog.
- `ConflictResolver.tsx`: exports `ConflictResolverBody`, the per-hunk manual resolution editor without dialog chrome. Fetches the case's current snapshot on open (same fetch-on-mount/loading/error pattern as `RollbackImpactDialog.tsx`), lists conflicted files down the side, and renders each real hunk as a two-pane ours/theirs diff (`.conflict-panes`, reused from the same CSS the automatic-resolver-era prototype left behind) with a `SegmentedControl` choice; a file with more than one hunk gets a bulk "apply to every section" control. Submission is disabled until every hunk in the snapshot has a choice, and again server-side (the API route recomputes the required set from the same R2 body rather than trusting the client).
- `Rail.tsx`: panel chrome, movement, collapse, expansion, and resize behaviors.

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

The theme choice is deliberately a per-device preference: localStorage `openfloor:theme`, owned by `components/ThemeToggle.tsx`, never synchronized through D1 or presence.

The guided tour's seen-it flags follow the same convention: localStorage `openfloor:tutorial:home:<userId>` and `openfloor:tutorial:floor:<userId>`, owned by `components/GuidedTour.tsx` (ENG-17). The tour auto-opens once per surface on a device with no flag and never returns after Skip or completion; the `<userId>` suffix means a recreated account sees it again, but the dismissal itself stays device-local like the theme. Steps advance only when the user clicks the highlighted element itself (a missing anchor — a control the current role doesn't render — falls back to a Next button), so the tour progresses by doing rather than by reading. `HOME_TOUR` (`components/product/HomeScreen.tsx`) continues past the New session tile into the create dialog it opens, walking Task, Goal, Repository, Candidate branch name, and the AI connection section before ending on the real Create session submit; anchors without a semantic selector (Task, Goal, Candidate branch name) carry a `data-tour` attribute for the tour to target. A user who clicks through without filling task/repository reaches a disabled submit with no click to advance on — Skip is the only escape hatch there, deliberately not a fallback button, since a disabled control isn't a missing one.

### Styling

- Global styles are composed from `app/globals.css` and files under `app/styles/`.
- `tokens.css` is the design-token source.
- Theming: the bare `:root` block in `tokens.css` is Light (crisp near-white); the dark values live twice (under `prefers-color-scheme` guarded against every manual theme, and under `:root[data-theme="dark"]`, deep dark) and must stay identical. Stone is the warm cream manual variant and Charcoal is the warm dark manual variant. `components/ThemeToggle.tsx` cycles System → Light → Stone → Dark → Charcoal, persisting the manual choice in localStorage (`openfloor:theme`); an inline script in `app/layout.tsx` applies it pre-paint. Never hardcode a color a theme must change — the code workbench's inverse surfaces are the deliberate exception (dark in every theme).
- The bare `:root` tokens back the default light theme, overridden by `.shop-shell` (`app/styles/shop.css`) for `/home`, `/onboarding`, `/settings`, and the session lobby; `.entry-shell` (`app/styles/layout.css`) for the pre-auth landing page; `.app-shell` (`tokens.css`, appended after the four base themes) for `/floor`. `.app-shell`'s light/dark values are ported from `.shop-shell`'s so the floor matches those other shells; it follows the identical `:root[data-theme="dark"] .app-shell, :root[data-theme="charcoal"] .app-shell` plus byte-identical `prefers-color-scheme` resolution pattern. Per-agent tones (`app/styles/components.css`, `--agent-color`) and identity tints (`--who-1/2/3`, `tokens.css`) are retuned inside that same block.
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
  conflicts.ts               Durable conflict cases, resolver attempts/questions, transitions, and review reads
  repositories.ts            Owner-gated GitHub connection and check-command persistence
  preflights.ts              Durable preflight/check state and internal Workflow transitions
  runs.ts                    Durable agent-run lifecycle, checks, files, artifacts, thread resume, and execution context
  candidate-feedback.ts      PR feedback nudge context, responsible-agent lookup, and compare-and-set queue writes
  rollbacks.ts               Authorized durable rollback attempts and candidate lease transitions
  session-context.ts         Session-scoped, member-neutral floor read for the agent brief (D1)
drizzle/                     Generated D1 migrations and metadata
lib/
  floor-types.ts             Public persisted floor types
  session-types.ts           Session, identity, presence, and typing event types
  session-context.ts         Pure session-brief renderer (no D1); shared by dispatch and live re-read
  conflict-resolver-prompt.ts Pure specialized resolver prompt renderer
  run-resume.ts              Pure provider-thread resume eligibility (which earlier run a new attempt may continue)
  pr-feedback.ts             Pure PR feedback nudge messages, signatures, and dedup planning
  candidate-feedback.ts      Webhook-driven PR feedback re-observation and nudge queueing
  conflict-notifications.ts  Device-local attention event and multi-tab browser-alert claim helpers
  validation.ts              Bounded input parsing and normalization
  identity.ts                Access verification and local identity isolation
  invites.ts                 HMAC signing and constant-time verification
  stripe.ts                  Stripe client, bindings, and webhook signature verification
  stripe-billing.ts          Checkout, Portal, reconciliation, and account-cancellation orchestration
  credential-crypto.ts       AES-GCM encryption at rest for provider credentials
  provider-credentials.ts    Pure provider/credential types, per-provider default models, run resolution order
  provider-validation.ts     Connect-time key validation against provider models endpoints
  claude-sandbox-settings.ts Pinned Claude-runner sandbox posture serializer
  gemini-settings.ts         Pinned Gemini CLI system-scope settings and the shared srt posture serializer
  qwen-settings.ts           Pinned Qwen Code CLI system-scope settings (qwen + deepseek runs)
  openai-chat-compat-gateway.ts  Shared chat-completions gateway handler (qwen, deepseek routes)
  anthropic-compat-gateway.ts    Shared Anthropic-Messages gateway handler (anthropic, kimi, glm routes)
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
scripts/qwen-runner.mjs      Pinned Qwen Code CLI runner (non-root, srt-wrapped) serving qwen and deepseek in the same image
scripts/openfloor-mcp.mjs    Stdio MCP server exposing read-only session context and run-scoped conflict input
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
- Conflict validation, state/prompt rendering, notification event selection/deduplication, and real multi-file three-way workspace construction.

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
- Conflict default-on migration preservation, idempotent detection, priority/capacity routing, retry budgets, provider/quota handling, owner/member authorization, cross-session concealment, exact-question answer races, runtime-token binding, and ended-session refusal.
- Integrated-run rollback authorization for session owners, agent owners, and every-prompt authors; owner-only engineer/agent groups; mixed-author exclusion; exact preview SHA/run-set rejection; pagination beyond 20 runs; newest-first atomic child completion/failure; failed-attempt retry; legacy-row preservation; candidate lease release; audit preservation; Queue status; and active/History Review behavior.

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
- Default conflict automation, automatic and manual resolver states, owner/original-author answers, unrelated-member waiting UI and concealed rejection, stale-answer rejection, reload durability, browser-permission handling, one hidden-tab notification, and exact Review click-through.
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

`CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, `GEMINI_RUN_ENABLED`, `GLM_RUN_ENABLED`, `QWEN_RUN_ENABLED`, and `DEEPSEEK_RUN_ENABLED` independently gate their providers' runs (one flag per provider id; `disabledRunProviders()` in `lib/provider-rollout.ts` is the single reader, re-exported by `lib/agent-run-start.ts` for compatibility). For each: keep it `false` until the deploy containing its code (and any bumped image) is live, its gateway route is reachable, and a credential resolves (owner-connected or server) — then run the per-provider acceptance runbook (staging session, full run arc, gateway rejected-path log review) before flipping. While a flag is false, a *manual* start of that provider's item refuses as `disabled` at the `startQueueItemRun` seam, agent *creation* and generated-agent default selection for it refuse with `503`, and *auto-dispatch* skips its items per-item (`RoutingDeps.disabledProviders`) so they never hold the rest of a mixed queue; other providers' runs are unaffected either way. Rollback = flip back: existing agents persist and generated-provider resolution ignores disabled choices until an enabled credential/default is available.

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
- `GITHUB_APP_CLIENT_ID` (optional binding, but required for device-flow sign-in: GitHub App → General → Client ID, with "Enable Device Flow" ticked on the App; absent, the device endpoints answer 501 and the dialog falls back to the install redirect)
- `GITHUB_CLIENT_SECRET` (optional binding, but required to skip the post-install re-verification: the App's client secret, paired with "Request user authorization during installation" enabled on the App. Absent, the install callback cannot exchange the redirect's OAuth `code`, so every install returns `?github=verify` and the device dialog reopens for a second device code)
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
- `ZAI_API_KEY` (optional: same contract for GLM runs)
- `DASHSCOPE_API_KEY` (optional: same contract for Qwen runs — an Alibaba Cloud Model Studio key for the international/Singapore region, the only region the gateway's upstream serves)
- `DEEPSEEK_API_KEY` (optional: same contract for DeepSeek runs)

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
- PR feedback nudges carry no CI log tails (that needs an Actions:read App permission every installer would re-accept) and name one responsible agent per nudge; the GitHub App must subscribe to `pull_request_review` and `pull_request_review_comment` or those nudges never fire.
- Thread resume covers the Codex, Claude, and Qwen Code runners (`resumableProvider`); Gemini runs always start fresh. A resume needs the prior attempt's `session_store` artifact, which is capped at 8 MB compressed — an oversized transcript logs a `session_store_skipped` event and the next attempt starts fresh.
- Browser conflict alerts require an open hidden floor tab, explicit per-device opt-in, and browser permission. Web Locks plus a localStorage receipt suppress duplicate multi-tab alerts. There is no closed-app push, email, or third-party delivery.
- The UI contains restored visual affordances from a prototype; verify backend wiring before claiming any action is real.
- Wrangler is pinned. A newer compatibility date may be rejected until Wrangler is upgraded deliberately.
- This `AGENTS.md` is the comprehensive context source; keep shorter README and focused docs consistent with it.

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
- `npm test` passes.
- `README.md`, `docs/agent-backend-gaps.md`, and this file are updated where relevant.
- New durable decisions are appended to [`docs/decision-log.md`](docs/decision-log.md).
- No secrets, local environment files, build output, or test artifacts are included.
- Deployment and production mutation occur only with explicit authorization. Merging to `main` is that authorization: it triggers the automatic production deploy. Agents still never run manual deploys or mutate production state directly without being asked.

# Task: let a member see and change an agent's **billing credential** and **model** — including after the agent exists

You are working in the openfloor repo, branching off `main`. Read `AGENTS.md` completely first — its "Mandatory maintenance rule" (AGENTS.md:7) applies to every commit here. `docs/glm-grok-subscription-provider-prompt.md` is the direct precedent: its §1 shipped the credential-kind plumbing this brief exposes, and its **§6 (per-agent model selection) was written but never landed** — this brief is that section, finished, plus the billing-visibility gaps §1 left behind.

Three sections, ordered by ascending risk: make the existing choice visible (§1), add model selection at creation (§2), and make both editable after creation (§3). §3 is the only section with a real hazard in it, and it is a billing hazard — read its opening paragraph before writing any code.

**There are no spikes and no migration in this brief.** Both columns already exist (`db/schema.ts:224` `credential_kind`, `db/schema.ts:225` `model`), both resolvers already honor them, the model allowlists were already read from each vendor's models endpoint during the previous brief's Step 0, and no new vendor surface, credential kind, or gateway behavior is introduced. If you find yourself writing a spike, you have misread the task.

## What exists today

The backend is complete on both axes. Only the input surface is missing — and for billing, the *output* surface too.

- `db/schema.ts:224` — `floor_agents.credential_kind`, nullable open enum, no CHECK. Null means "the owner's default".
- `db/schema.ts:225` — `floor_agents.model`, nullable. Null means "the provider's default".
- `lib/provider-credentials.ts:110` — `DEFAULT_PROVIDER_MODELS`; `:118` — `resolveRunModel(provider, agentModel)` already falls back to it.
- `db/runs.ts:107` — `resolveRunModel` is called **once, at run creation**, and the answer is frozen into `agent_runs.model` (`db/schema.ts:524`, NOT NULL). `worker/agent-run-workflow.ts:382` passes it to the sandbox as `OPENFLOOR_MODEL`; each runner consumes it (Claude/Codex SDK `model` option, Gemini CLI `-m`). **Consequence that matters for §3: editing an agent's model can never disturb an in-flight run.**
- `db/provider-credentials.ts:132` — `getRunAgentOwnerCredential` joins on `fa.credential_kind`: a named kind matches only its own row; null prefers `api_key` via `ORDER BY CASE WHEN c.kind = 'api_key' THEN 0 ELSE 1`. `:171` — `resolveRunProviderSecret` wraps it, and `lib/provider-credentials.ts:140` `resolveRunCredentialSource` refuses (`missing_selected_kind`) when the agent names a kind the owner lacks — **even when a server key exists.**
- `lib/anthropic-compat-gateway.ts:69` — the gateway calls `resolveRunProviderSecret(claims.runId, …)` **on every proxied request**, not once at run start. This is the §3 hazard.
- `lib/provider-credentials.ts:34` — `credentialKindsForProvider`: `anthropic` returns both kinds, every other provider returns `["api_key"]`. So `anthropic` is the only provider with a billing choice today, and openai's `oauth` stays withheld (that decision is not reopened here).
- `components/session/CreateAgentDialog.tsx:96` — the Billing field, rendering only when `credentialKindsForProvider(provider).length > 1`. `:79` — the Provider field, rendering only when `enabledProviders.length > 1`. `:37` — `provider` state initialized to a hardcoded `"openai"`.
- `lib/validation.ts:71` — `parseAgentInput` validates `credentialKind` against `credentialKindsForProvider(provider)`. It never reads `input.model`.
- `db/floor.ts:260` — the create INSERT lists `credential_kind` and **omits `model`**. `db/floor.ts:343` — the generated-agent INSERT omits both.
- `db/floor.ts:50` — `readFloorSnapshot`'s agent SELECT lists `a.model` but **not `a.credential_kind`**; `lib/floor-types.ts:23` `FloorAgent` matches. So the client can already read an agent's model and can never read its billing.
- `db/floor.ts:386` — `updateFloorAgentTask`, the only agent-settings mutation: membership check, `kind IS NULL` (persistent agents only), `deprovisioned_at IS NULL`, session-not-ended guard, `bumpFloorRevision`. `app/api/sessions/[id]/agents/[agentId]/route.ts:10` is its route; `lib/validation.ts:93` `parseAgentTaskInput` accepts `{ task }` and nothing else.
- `db/floor.ts:410` — `AGENT_ACTIVE_RUN_STATUSES`, the "has real in-flight work" set `deleteFloorAgent` already uses to refuse with `409`. §3 reuses it verbatim.

## The four defects this brief closes

State these in the decision-log entry; they are the reason the brief exists.

1. **A member cannot see which credential an agent bills.** `credential_kind` is absent from the floor snapshot and from `FloorAgent`, so with an API key and a subscription both connected there is no way to tell which agent spends which — the exact question that motivated this work.
2. **A member cannot change it.** Exhaustive grep of `UPDATE floor_agents` in non-test code (13 sites) shows none sets `credential_kind` or `model`. Delete-and-recreate is the only path.
3. **Two error messages instruct the user to do something the product cannot do.** `db/provider-credentials.ts:208` says *"Connect it in Settings or change the agent"*; the openai gateway says *"Set this agent's Billing to API key…"*. Both are dead ends today. §3 makes them true — and until §3 lands, §1's read-only display at least makes them diagnosable.
4. **A latent 503 in the create dialog.** `provider` state is only ever mutated by the Provider select, which is gated on `enabledProviders.length > 1`. Enable exactly one provider and that dropdown never renders, so `provider` stays at its hardcoded `"openai"`, Billing stays hidden, and the POST 503s at `app/api/sessions/[id]/agents/route.ts:19`. `openai` is never flag-gated today so `enabledProviders` always holds at least two entries and this stays latent — fix it anyway, in §2, where the dialog is already open.

---

## §1. Surface the billing choice (read-only, zero risk)

No migration, no new route, no behavior change. This is the smallest commit in the brief and it independently answers the user-facing question.

- `db/floor.ts:50` — add `a.credential_kind AS credentialKind` to the agent SELECT. Add it to `AgentRecord` alongside `model`.
- `lib/floor-types.ts:23` — `FloorAgent` gains `credentialKind: CredentialKind | null`. Correct the existing comment at `:34` (*"model selection is a later milestone"*) in the commit that makes that false, not before.
- `components/session/AgentCard.tsx:76` — the spotlight identity line reads `{agent.role} · {AGENT_PROVIDER_LABELS[agent.provider]} · owned by {agent.ownerName}`. Append the model when `agent.model` is non-null and the billing kind when `agent.credentialKind` is non-null, using `credentialKindLabel(agent.provider, agent.credentialKind)` (`lib/provider-credentials.ts:40`, already exported and already worded "API key" / "Claude subscription"). Both null → the line is byte-identical to today, so no existing agent's card changes.
- Do **not** add either to the compact `AgentCard` head. That line is already three elements deep in a tile that has to stay scannable at floor density; the spotlight is where agent detail lives.

**Privacy check that must not be lost.** Showing an agent's *own* stored choice is not the thing `docs/glm-grok-subscription-provider-prompt.md:211` forbids. That rule forbids revealing **which kinds a given owner has connected** — a different member's credential state. An agent's `credential_kind` is a property of the agent, chosen in a dialog every member can already open, and is exactly what makes the §3 refusal message actionable. Say so in a code comment so a future reader does not "fix" it back.

## §2. Model selection at creation (closed allowlist, no migration)

The previous brief deferred this once on a specific objection, then answered it and never shipped the answer: *"a free-text model input is a new validation surface whose failure mode is a vendor 404 mid-run."* A closed per-provider allowlist answers that exactly. Do not reopen it as free text.

- **Replace `DEFAULT_PROVIDER_MODELS` with `PROVIDER_MODELS: Record<CredentialProvider, readonly string[]>`, first entry = the default.** One source of truth instead of two that can disagree. Keep a `DEFAULT_PROVIDER_MODELS` alias export if it shortens the diff, but do not let two independently-editable lists exist — `tests/unit/provider-credentials.test.ts` pins `PROVIDER_MODELS[p][0] === DEFAULT_PROVIDER_MODELS[p]` for every provider precisely to stop that drift. `resolveRunModel` is otherwise unchanged.
- `lib/validation.ts:71` — `parseAgentInput` gains one line: reject `input.model` when it is defined and not in `PROVIDER_MODELS[provider]`. A closed set means an unknown id is a `400` at creation, never a vendor 404 mid-run. Omitted/null stays valid and means "provider default".
- `db/floor.ts:260` — add `model` to the INSERT column list and bind `input.model`. The generated-agent INSERT at `:343` stays as it is: auto-provisioned workers and the Concierge take the provider default, and there is no UI that would set anything else.
- `components/session/CreateAgentDialog.tsx` — a **Model** `SelectMenu` populated from `PROVIDER_MODELS[provider]`, first option "Provider default" (value `null`). It must re-key off the provider field exactly the way Billing already does at `:87` (`setCredentialKind(null)`), or you will post `claude-opus-5` to Moonshot. Render it unconditionally — every provider has at least one model, so unlike Billing there is no one-option case to hide.
- **Fix defect 4 in the same commit:** initialize `provider` from `enabledProviders[0] ?? "openai"` rather than the bare `"openai"` literal, and add a `ponytail:` comment naming why (the Provider select is conditionally rendered, so the initial value has to be right on its own).

### Banked allowlists — do not re-read these endpoints

`docs/glm-grok-subscription-provider-prompt.md:178-199` recorded every provider's models endpoint during that brief's Step 0 (2026-08-24/25). Copy them from there. The general rule recorded with them still governs: **the listing is authoritative for which models exist, not for which id form to pin — prefer an undated alias wherever one resolves**, because a dated snapshot 404s when it retires, which is the exact failure the allowlist exists to prevent.

Anthropic's list is the one that answers the actual request (Sonnet vs Opus), pinned as verified there:

| Model | Id | Context | $/1M in | $/1M out |
|---|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M | $10 | $50 |
| Claude Opus 5 | `claude-opus-5` | 1M | $5 | $25 |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5 | $25 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $2 | $10 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 | $5 |

Keep `claude-opus-5` first — it is today's default and this brief does not change any default. Ids are complete as written; **never append a date suffix**. Exclude `claude-mythos-5` (invitation-only). Two footnotes worth a code comment: `claude-haiku-4-5` is the only 200K-context entry, and `claude-fable-5` is unavailable under zero data retention, so a ZDR-configured org gets a `400` rather than a run.

`kimi`, `glm`, and `gemini` lists come from the same doc. Gemini carries one curation caveat recorded there: the pinned CLI rewrites some ids through its own resolution table (`gemini-3.7-flash` → `gemini-3.5-flash` at pin 0.56.0), so the curated list must contain ids that actually reach the wire. `openai` stayed blocked on a key at that pass — until one exists, its entry is the single existing default `gpt-5.6-terra`; do not guess `gpt-5.6` variants from memory. `grok` has no entry (Gate B failed; the provider does not exist in `CREDENTIAL_PROVIDERS`).

### Two limits to state in code and help text rather than engineer around

- **The allowlist goes stale.** A model shipped after the last edit is unpickable until someone edits the constant. That is a code change, not a broken run — the correct direction for this failure to point. Do **not** fetch `/v1/models` at dialog render: per-provider auth, caching, and a network call in a modal, to save one constant edit.
- **The allowlist is per provider, not per credential.** A member's Claude Pro plan may not include every model valid for `anthropic`. That surfaces at run start as the vendor's own error. openfloor has no authoritative source for plan entitlements and must not model them.

## §3. Editing both after creation — and the mid-run payer switch

**Read this first.** `resolveRunProviderSecret` is called by the gateway on **every proxied request** (`lib/anthropic-compat-gateway.ts:69`), and it reads `fa.credential_kind` live. Model is safe — it is frozen into `agent_runs.model` at run creation (`db/runs.ts:107`) and read from there. Billing is not: change `credential_kind` while a run is in flight and that run's *next* request bills the other credential. That is a silent mid-run payer switch, the precise thing `lib/provider-credentials.ts:128-139`'s invariant exists to forbid, arrived at from a new direction.

Do not solve it by snapshotting the kind onto `agent_runs` — that is a migration, a second source of truth, and a resolver rewrite to fix a case the user has no reason to want. Solve it the way the codebase already solves "this agent has real in-flight work":

- **Refuse a `credentialKind` change while the agent has an active run**, reusing `AGENT_ACTIVE_RUN_STATUSES` (`db/floor.ts:410`) and the `409` shape `deleteFloorAgent` already returns. Message: the agent has a run in flight, stop it or wait. A `model` change needs no such guard — say why in the comment, or someone will add one for symmetry and make the product worse.

The rest is deliberately one route and one function:

- `lib/validation.ts:93` — generalize `parseAgentTaskInput` into `parseAgentSettingsInput`, returning a **partial** `{ task?, model?, credentialKind? }` with at least one key present. `credentialKind` must distinguish **absent** (leave alone) from **explicit `null`** (set to "Owner's default"); `model` likewise. Getting that wrong means the Billing control can never be reset to the default. Keep the existing task rules unchanged (trimmed, non-empty, ≤1000) — this is a generalization, not a relaxation.
- `db/floor.ts:386` — generalize `updateFloorAgentTask` into `updateFloorAgentSettings(sessionId, userId, agentId, patch)`, building the `SET` clause from the keys actually present. Every existing guard stays exactly as written: membership, `kind IS NULL`, `deprovisioned_at IS NULL`, session-not-ended, `bumpFloorRevision`, and the `changes === 0` re-check that distinguishes "not a member" from "not an editable agent".
- **Validate `model` against the agent's stored provider, not a client-supplied one.** The PATCH body carries no provider, and trusting one would let a caller set `claude-opus-5` on a Kimi agent. Read the row's `provider` in the same function before the UPDATE and validate against `PROVIDER_MODELS[provider]`. There is no race to worry about: `provider` is immutable for persistent agents — the only `UPDATE` that touches it (`db/floor.ts:328`, the generated-agent reuse path) is unreachable here behind the `kind IS NULL` guard. Say that in the comment rather than adding a lock. Validate `credentialKind` against `credentialKindsForProvider(provider)` from the same read.
- `app/api/sessions/[id]/agents/[agentId]/route.ts:10` — the existing PATCH takes the new parser. **Do not add `/model` or `/billing` sub-routes.** `pause` and `stop` are separate routes because they are separate verbs with different authorization; these are field edits on the same resource the same members already PATCH.
- `components/session/usePersistentFloorData.ts:85` — `updateAgentTask(agentId, task)` becomes `updateAgentSettings(agentId, patch)`, or gains two siblings that call the same endpoint. Prefer whichever leaves `AgentSpotlight`'s call sites clearest; do not add a second `request` path.

## §UI

- `components/session/AgentCard.tsx:86` — `AgentSpotlight` already carries the one agent-editing surface in the product, the `spotlight-row` holding `AgentTaskEditor`, gated on `!agent.kind`. Add **Model** and (when `credentialKindsForProvider(agent.provider).length > 1`) **Billing** rows beside it, same gate, same `SelectMenu` the create dialog uses. System-managed agents keep rendering read-only detail lines, exactly as `Task` does today.
- Saving is immediate on change — the existing rows in this component are either an editor with its own save affordance or a control that applies at once. Do not introduce a third pattern (a form with an Apply button) for two selects.
- The `409` from an in-flight billing edit surfaces through the existing `mutationErrorResponse` path and the floor's existing error notice. No new error surface.
- `CreateAgentDialog`'s Billing options stay **hardcoded and unfiltered by what the owner has connected** — that is deliberate (`docs/glm-grok-subscription-provider-prompt.md:211`) and unchanged here. §1's display and §3's editability are what make the resulting run-time refusal recoverable.

## §Tests

`package.json:15` enumerates the worker test files — **a new worker test file silently never runs.** Put worker cases in the existing files.

- `tests/unit/provider-credentials.test.ts` — `PROVIDER_MODELS[p][0] === DEFAULT_PROVIDER_MODELS[p]` for every provider (the anti-drift assertion). Keep the existing `resolveRunModel` pins at `:51-58`, including the literal `"claude-sonnet-5"` case, passing through the refactor — that case is now reachable from production code for the first time.
- `tests/unit/validation.test.ts` — `parseAgentInput` accepts an allowlisted model, rejects `"claude-opus-5"` under `provider: "kimi"`, and still accepts input omitting `model` entirely. `parseAgentSettingsInput` accepts a task-only body (proving the old contract survives), accepts `credentialKind: null` as an explicit reset **distinguishably from omission**, and rejects an empty patch.
- `tests/worker/floor.test.ts` — editing model on a persistent agent; the same edit refused on a system-managed (`kind IS NOT NULL`) agent; a model rejected for the agent's stored provider returning `400` **without** the client having sent a provider; and the billing edit refused with `409` while a run sits in an `AGENT_ACTIVE_RUN_STATUSES` state, then accepted once it is not. That `409` case is the most important new test in the brief — it is the assertion that stops a mid-run payer switch.
- `tests/worker/credentials.test.ts` — an agent whose `credential_kind` was changed post-creation resolves the newly named credential on its next run. The existing two-agents-two-kinds and null-kind-default cases stay untouched.
- `tests/render/` — the create dialog renders the Model field and resets it when Provider changes; the spotlight renders Model and Billing for a persistent agent and neither control for a generated one.
- `npm test` green on every commit.

## §Constraints and invariants

- **Never silently switch payer.** Unchanged, and it now also covers the post-creation edit: a billing change during an in-flight run is refused, not applied.
- **No migration.** Both columns exist. If you reach for `drizzle-kit generate`, stop and re-read `db/schema.ts:224-225`.
- **No new gateway behavior, no new credential kind, no new provider.** openai's withheld `oauth` kind stays withheld; that decision (AGENTS.md's 2026-08-25 entry) is not reopened.
- **`RUN_SANDBOX_IMAGE_VERSION`: no bump.** No runner script and no `Dockerfile.sandbox` line changes — `OPENFLOOR_MODEL` already reaches every runner.
- **Generated agents stay untouched.** Both INSERTs keep omitting these columns, and every edit path keeps its `kind IS NULL` guard. System-managed agents are router-controlled; that is the existing contract.
- **No per-agent reasoning effort.** Same dialog shape and the natural follow-on, but a second axis the runners do not thread today. It stays in `docs/agent-backend-gaps.md`.
- `AGENTS.md` in the same change: the `floor_agents` entry (`:552` — correct both "has no UI yet" for `model` and the creation-only wording for `credential_kind`), the API contracts table (`:708` — PATCH now takes `{ task?, model?, credentialKind? }`), validation limits (`:788`), the implemented-capabilities list (`:198`), and one decision-log entry covering all four defects. In `docs/agent-backend-gaps.md`, delete "per-agent model selection" from the deferred list and delete "Per-agent **model** selection in the agent-creation UI" from the not-simulated list; the "Persistent-agent editing beyond the existing task field" line narrows to ownership transfer and queue completion/removal.

## §Sequencing (one commit per line, `npm test` green each)

1. Commit 1 — §1: `credential_kind` into the snapshot, the type, and the spotlight identity line. Deployable and useful on its own; it answers "which agent bills what" without touching a single write path.
2. Commit 2 — §2: `PROVIDER_MODELS`, `parseAgentInput`, the create INSERT, the Model field, and the `enabledProviders[0]` initialization fix.
3. Commit 3 — §3: the generalized parser, `updateFloorAgentSettings`, the in-flight `409` guard, the client method, and the spotlight rows.
4. Docs commit if `AGENTS.md` and `docs/agent-backend-gaps.md` were not folded into 1–3 (prefer folding — the maintenance rule wants them in the same commit as the change they describe).

No flag and no staged rollout. Nothing here gates a vendor surface, and every new field is optional with today's behavior as its null case — a member who touches neither control sees the product they have now.

## §Out of scope (each keeps or gets a `docs/agent-backend-gaps.md` line)

- Per-agent reasoning effort (`output_config.effort`).
- Changing an agent's **provider** after creation. Provider selects the runner, the gateway route, the skills/MCP support matrix, and the credential; a post-hoc switch is a different agent wearing the same name. Delete and recreate.
- Snapshotting `credential_kind` onto `agent_runs`. The `409` guard makes it unnecessary; adding it would be a migration and a second source of truth for whose credential a run bills.
- Fetching live model lists from vendor endpoints at render time, and modeling plan entitlements.
- Showing a member their remaining subscription quota, or another member's connection status. Unchanged from the previous brief.
- Token and cost metering. Runners still capture `usage` into `result.json` and `parseCodexResult` still discards it — a per-agent model picker makes cost *choosable*, not *visible*, and conflating the two would smuggle a metering milestone into this one.

## §Acceptance checklist

No flag flip. After the deploy containing all three commits:

1. With an Anthropic API key **and** a Claude subscription connected to one account, open an existing agent's spotlight and confirm its billing is now displayed.
2. Create one agent with Billing "API key" and one with Billing "Subscription", same owner, same provider. Run both. Confirm from the gateway logs that each used the credential its agent named — `x-api-key` for one, `authorization: Bearer` plus the merged `oauth-2025-04-20` beta flag for the other.
3. Create an agent with Model "Claude Sonnet 5", run it, and confirm `agent_runs.model` is `claude-sonnet-5` and the sandbox received it as `OPENFLOOR_MODEL`.
4. Change that agent's model to `claude-opus-5` in the spotlight, run it again, confirm the new run recorded the new model and the previous run's record is unchanged.
5. Switch a provider in the create dialog and confirm both Model and Billing reset — no `claude-*` id can be posted with a non-anthropic provider.
6. Start a run, attempt a billing change mid-run, confirm the `409` and that the running agent's requests keep resolving the original credential. Then let the run finish and confirm the change applies.
7. Disconnect the subscription and confirm the subscription-bound agent refuses with the `missing_selected_kind` message — and that the message's instruction ("change the agent") is now something the spotlight can actually do.

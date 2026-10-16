# Task: re-evaluate Grok (xAI) as an agent-run provider, and its plan usage — ENG-118

> Planning/research brief. This may describe an earlier state; consult AGENTS.md and implemented-features.md for current behavior. It is not an instruction to start new work.

You are working in the openfloor repo, on branch `ali/eng-118-grok-usage`, branched off `main`. Read `AGENTS.md` completely first — especially the two 2026-08-24 Grok decision-log entries. The "Mandatory maintenance rule" (AGENTS.md:7) applies to every commit here, **including a refusal commit**.

Linear ENG-118: *"Grok API usage doesn't work work, also want to import plan usage capabilities (if possible). Similar to how we have claude plan usage."*

**Status going in: Grok has been excluded twice, both times empirically, both on 2026-08-24.** This brief does not assume the exclusion can be reversed. It defines a Step-0 spike whose most likely outcome is a **third** decision-log entry, and specifies exactly what that commit contains. A documented refusal is a complete ticket, not a failure.

## What exists today

- `lib/provider-credentials.ts:5-9` — a load-bearing comment stating Grok is deliberately absent *twice over*. `:10` `CREDENTIAL_PROVIDERS = ["anthropic","openai","kimi","gemini","glm"]`. `:113` `AGENT_PROVIDER_LABELS`, `:124` `usesClaudeRunner` (anthropic/kimi/glm), `:164` `PROVIDER_MODELS` (closed allowlist, first entry = default), `:176` `DEFAULT_PROVIDER_MODELS`, `:202` `resolveRunCredentialSource`.
- `tests/unit/provider-credentials.test.ts:28` pins `parseCredentialProvider("grok") === null`. **The standing brief cites `:21`; it is `:28` now.**
- `lib/anthropic-compat-gateway.ts` — the shared Messages gateway behind `/runtime/anthropic`, `/runtime/kimi`, `/runtime/glm`. Kind-aware `buildAuthHeaders(secret, kind)`, `oauthBetaFlag` merge, `retry-after` + `anthropic-ratelimit-*` passthrough, `logAndConcealGet`.
- `app/runtime/openai/[...path]/route.ts` — 60 lines, **POST only, no GET handler**, single allowed path `responses`, upstream `https://api.openai.com/v1/responses`. Standalone, and it carries production traffic.
- `db/provider-credentials.ts:171` `resolveRunProviderSecret` — the one credential ladder every gateway calls.
- `lib/provider-rollout.ts:5` `disabledRunProviders()` — reads `CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, `GEMINI_RUN_ENABLED`, `GLM_RUN_ENABLED`. `GLM_RUN_ENABLED` is still `"false"` in `wrangler.jsonc`.
- `lib/runtime-token.ts:51` operation union (`glm` present, no `grok`); `:61` the 60-minute-TTL list.
- `worker/agent-run-workflow.ts:82` `RUN_SANDBOX_IMAGE_VERSION = "v4"` (**the standing brief says v3 — stale**). `:322` JWT operation, `:344` start command, `:349` `providerEnv`, `:375-378` the Codex branch. `:411` the 60-minute "wait for Codex" step timeout.
- `scripts/codex-runner.mjs:148` — `new Codex({ baseUrl, apiKey, ...(mcpServers ? { config: { mcp_servers } } : {}) })`.
- `Dockerfile.sandbox:7` — `@openai/codex-sdk@0.148.0`, matching `package.json`. **The same pin as the failed spike.** Latest published is `0.149.1`.
- `package.json:15` — the `test:worker` enumeration. A new worker test file not listed there never runs.

## Verified facts — re-verify anything load-bearing at Step 0

| # | Fact | Status |
|---|---|---|
| 1 | The Anthropic-compat route is dead: the Claude Code CLI puts `role: "system"` entries inside `messages[]`; `https://api.x.ai/v1/messages` returns `400 invalid-argument … Invalid message role.` A minimal repro isolated the role as the sole blocker — rewriting it to `user` returned 200 with correct `tool_use`. | Verified empirically 2026-08-24 (AGENTS.md:1683-1689). **Vendor-side; re-testable.** |
| 2 | The Responses route is dead at pin 0.148.0: turn one works after `features.collab=false`, but every thread's **second** request 400s `Could not decode the compaction blob`. Isolated byte-level to the explicit `"content": null` Codex writes on replayed reasoning input items (byte-exact xAI replay → 200; Codex serialization → 400; dropping `status` or mutating summary text → 200). | Verified empirically 2026-08-24 (AGENTS.md:1723-1729). **Pin-side and vendor-side.** |
| 3 | **`wire_api = "chat"` is gone from the pinned CLI, not merely "at doc level".** The vendored binary at 0.148.0 contains the literal strings `` `wire_api = "chat"` is no longer supported. `` and ``How to fix: set `wire_api = "responses"` in your provider config.`` The `wire_api` key still deserializes in the `model_providers` TOML schema; the **value** `"chat"` is hard-rejected. | **Verified in-repo, 2026-08-26.** Upgrades `docs/kimi-grok-gemini-provider-prompt.md` fact 4 from doc-level to binary-level. |
| 4 | The SDK forwards arbitrary `config` overrides as `--config key=value` (`node_modules/@openai/codex-sdk/dist/index.js:174-178`), sets `openai_base_url` from `baseUrl` (`:180-184`), `model_reasoning_effort` from `modelReasoningEffort` (`:207`), and `CODEX_API_KEY` from `apiKey` (`:246`). So provider configuration **is** a runner-side lever, not a gateway rewrite — the `features.collab=false` precedent. | Verified in-repo. |
| 5 | The pinned CLI guards custom provider ids: `model_providers contains reserved built-in provider IDs:`. Whether `xai` is reserved is unknown. | Unverified — establish only if it ever matters. |
| 6 | Grok model ids from the 2026-08-24 spike: `grok-4.5` (aliases `grok-4.5-latest` / `grok-build-latest`) and `grok-build-0.1` (alias `grok-code-fast-1`). The CLI is WebSocket-first: five `ws://…/responses` upgrade attempts, ~7s, before an automatic HTTPS fallback a POST-only gateway always incurs. Only path called: `/responses`. Headers the current OpenAI route does not forward: `originator`, `session-id`, `thread-id`, `version`, `x-client-request-id`, `x-codex-beta-features`, `x-codex-turn-metadata`, `x-codex-window-id`. | Verified 2026-08-24; banked for the day this reopens. |
| 7 | Whether a Grok **subscription** (SuperGrok / X Premium) exposes any pasteable, non-interactive credential a CLI can use. | **Unverified and load-bearing.** Do not assume either answer. |

**Explicitly closed — do not re-litigate:** the `wire_api = "chat"` route at the current pin (fact 3). It would have been a legitimate runner-side config choice under fact 4, and Chat Completions carries no encrypted reasoning blobs so the `"content": null` replay blocker structurally could not apply — **but the pinned binary refuses the value with a fix-it message naming `"responses"`.** It is closed by the code we ship, not by a doc.

## Step 0 — the spike, in ascending cost order, with one hard gate

Nothing lands until this reports. No deploy. Obtain a scratch xAI key first. Run the steps in this order and **stop at the first one that opens a route** — the earlier the step, the cheaper the resulting change.

### G1 — the cheapest possible win: has xAI fixed system-role messages?

The only route needing **no Codex pin movement, no runner change, no image bump, and no new gateway shape**. If this passes, Grok is the Kimi recipe verbatim: one ~20-line route on the existing `handleAnthropicCompatProxy`.

1. `POST https://api.x.ai/v1/messages` with `authorization: Bearer $XAI_API_KEY`, `anthropic-version: 2023-06-01`, a trivial 64-token message. Record status. Repeat with `x-api-key`.
2. Repeat with `"stream": true`; confirm Anthropic SSE framing (`message_start` / `content_block_delta` / `message_stop`).
3. **The killer check.** Replay a captured Claude-Code request containing a `role: "system"` entry inside `messages[]`. Capture one by pointing a local logging proxy at `ANTHROPIC_BASE_URL` and running `scripts/claude-runner.mjs`. A 200 with a correct `tool_use` block is the pass.
4. `POST /v1/messages/count_tokens` — record status. A 404 is fine (Moonshot precedent); the allowlist forwards it either way and the CLI degrades on the vendor's answer, not on concealment.
5. `GET https://api.x.ai/v1/models` with Bearer — the connect-validation URL and the real `PROVIDER_MODELS.grok` list. **Read the endpoint; never pin a marketing name** (`lib/provider-credentials.ts:153-154` records the `kimi-k3[1m]` lesson).
6. End to end: `OPENFLOOR_ANTHROPIC_BASE_URL=https://api.x.ai OPENFLOOR_ANTHROPIC_TOKEN=$XAI_API_KEY OPENFLOOR_MODEL=<id>` against the **unmodified** `scripts/claude-runner.mjs` in a scratch workspace. Pass = a real file edit and `result.json` `ok:true`. Log every model id in every request body — a `claude-*` id means the alias passthrough fires and the image bumps.

**G1 step 3 passes → take route A (§A) and stop spiking.** Otherwise continue.

### G2 — is `wire_api = "chat"` reinstated at the current latest SDK?

Fact 3 closes this at `0.148.0`. The only thing left is whether a newer pin reopens it.

1. `npm view @openai/codex-sdk version` and `npm view @openai/codex-sdk versions --json | tail` — record today's latest and the cadence since 0.148.0.
2. In a **throwaway directory** (not this repo — no lockfile churn), `npm install @openai/codex-sdk@latest`, locate the vendored binary, and run the same string check: `strings -a <binary> | grep 'wire_api = "chat"'`. Presence of the "no longer supported" string closes it; absence, plus a live `--config model_providers.xai.wire_api="chat"` run that reaches the wire, opens it.
3. Only if reinstated: confirm `xai` is not a reserved built-in provider id (fact 5), then drive `POST https://api.x.ai/v1/chat/completions` through the SDK with the full provider table pushed via `config` (`model_providers.xai.{base_url,env_key,wire_api}` + `model_provider="xai"`), and establish (a) tool calls round-trip, (b) streaming works, (c) a real **multi-turn** edit completes — turn one is not the test, turn two is — and (d) the exact upstream path, which becomes a **new gateway route shape** (`/v1/chat/completions`, not `/responses`).

Record the answer either way. If closed: one sentence in the decision log citing the binary string, so this route is never re-proposed.

### G3 — does the current latest SDK still emit `"content": null`?

This is the single fatal byte from fact 2.

1. **Free variant first, at the existing 0.148.0 pin.** The SDK exposes `modelReasoningEffort` (`dist/index.js:207` → `--config model_reasoning_effort=`), and the pinned binary's accepted values include `none` alongside `minimal|low|medium|high|xhigh`. If effort `none` makes Codex emit no reasoning items to replay, the fatal field never appears — and that is a **runner-side config choice, identical in kind to `features.collab=false`, not a gateway body rewrite.** Do not assume it works: **establish that effort `none` suppresses reasoning *input item replay*, not merely reasoning output**, and measure what it costs in code quality on a real task. This is the one genuinely untried lever at the current pin.
2. Then the pin-bump variant: throwaway `@openai/codex-sdk@latest` install, `baseUrl` = a local logging proxy into `https://api.x.ai/v1`, `apiKey` = the scratch key, `config: { features: { collab: false } }`, and the exact `startThread` options `scripts/codex-runner.mjs:149-156` uses (`sandboxMode: "workspace-write"`, `approvalPolicy: "never"`, `networkAccessEnabled: false`, `webSearchMode: "disabled"`). From the proxy log, read the **second** request's replayed reasoning input item and check for an explicit `"content": null`. If it is gone, run a real multi-turn edit end to end and confirm no compaction-blob 400.

**A pin bump is not a Grok-only change.** It costs:
- `package.json` + `Dockerfile.sandbox:7` both move, so `RUN_SANDBOX_IMAGE_VERSION` goes `v4 → v5` — a `COPY`'d-script-class change by the standing invariant.
- The live `openai` provider changes CLI version underneath production traffic. Regression testing is required before the bump lands, independent of Grok: a full-arc Codex run on the acceptance repository (dispatch → activity events → files → checks → publish → integrate → `providerThreadId`); the six activity-event kinds `scripts/codex-runner.mjs:106-126` maps still arriving with the same `item.type` values; the MCP bridge still spawning `openfloor-mcp.mjs`; SIGTERM → exit 130 cancellation still honored.
- `features.collab=false` and any effort override become permanent runner config that also applies to `openai` unless branched by provider. **Branch it.**

If G3 is the only thing standing between us and Grok, **say so explicitly in the report and let the repo owner price it.**

### G4 — does a Grok subscription expose a pasteable credential at all?

Independent of G1–G3; run it in parallel. **openfloor operating an OAuth login flow is out of scope by standing decision** (`docs/glm-grok-subscription-provider-prompt.md:258`). The only supported shape is paste-a-credential-you-minted-yourself.

Establish, from xAI's own documentation and console, whether a SuperGrok or X Premium subscription yields **any** credential meeting all five mechanical requirements:

1. Mintable by the member on their own machine, non-interactively enough to paste (the `claude setup-token` / `codex login` + copy `auth.json` shape).
2. Accepted by an xAI inference endpoint as a bearer-style header — because openfloor's only sanctioned mechanism is **header substitution in a gateway** (`AGENTS.md:1741`, the §4 Claude precedent). No body rewriting.
3. Fits an existing parse shape: `parseCredentialConnectInput` (`lib/validation.ts:296`) accepts a ≤512-char opaque token with no whitespace or control characters, or a ≤8192-char JSON object with `tokens.account_id` + `tokens.access_token`. A credential fitting neither needs a fourth branch, which is a real validation-surface change and should be priced as one.
4. Has a free validation probe (`GET /v1/models` with that credential), or is honestly stored `validated_at = null` — `validateProviderOauthSecret` (`lib/provider-validation.ts:41`) currently returns `null` for every provider but `anthropic`. **Never fake a validation timestamp.**
5. Does not rotate in a way that requires openfloor to write back into the member's own login. If it does, it inherits every ENG-117 hazard and should be gated the same way.

**If no such credential exists — the likely answer, given that xAI's API keys are console-minted pay-as-you-go artifacts and consumer subscriptions are a different product — that half of ENG-118 is a documented refusal, not an open question.**

### The gate

**Gate G passes** if G1 step 3 passes (route A), **or** G2 step 3 completes a real multi-turn edit (route B), **or** G3 step 1 or 2 completes a real multi-turn edit against `https://api.x.ai/v1/responses` with no compaction-blob 400 (route C).

**Gate G fails** if all three routes are still blocked. Then §Fail below is the entire deliverable.

Gate G4 is separate and answers only the subscription half. It can fail while Gate G passes (Grok ships API-key-only) or pass while Gate G fails (nothing ships; a credential nobody can use is worthless).

**Under no circumstances** does any route ship via request-body or role rewriting in a gateway. That rejection is what killed route (a) originally and it stands (`AGENTS.md:1727`).

## §A. If G1 passes — Grok via the Anthropic-compat gateway (cheapest)

Identical to GLM's shipped shape. Zero runner change, zero Dockerfile change, **no image bump**.

- Delete `lib/provider-credentials.ts:5-9` (the "deliberately absent twice over" comment). Replace with nothing — the provider's presence is the documentation.
- `CREDENTIAL_PROVIDERS` (`:10`) += `"grok"`. `PROVIDER_LABELS.grok = "xAI"` (`:67`). `AGENT_PROVIDER_LABELS.grok = "Grok"` (`:113`). `usesClaudeRunner` (`:124`) returns true for it. `PROVIDER_LOGOS.grok` (`:80`) — `/logos/xai.svg` if the mark exists in `public/logos`, else `null` and the monogram fallback handles it. `PROVIDER_KEY_GUIDE.grok` (`:88`) — placeholder + `https://console.x.ai`.
- `PROVIDER_MODELS.grok` (`:164`) — **from G1 step 5's endpoint read, in endpoint order, first entry the coding flagship.** Prefer an undated alias over a snapshot, per the comment at `:139`.
- `lib/runtime-token.ts:51` — add `"grok"` to the operation union; `:61` — add it to the 60-minute-TTL list.
- New `app/runtime/grok/[...path]/route.ts`, ~20 lines, copied from `app/runtime/glm/[...path]/route.ts`: `operation: "grok"`, `provider: "grok"`, `upstreamBase: "https://api.x.ai/v1"`, `serverKeyBinding: "XAI_API_KEY"`, Bearer `buildAuthHeaders` (per G1 step 1 — Bearer is xAI's documented form), `allowedPaths: new Set(["messages", "messages/count_tokens"])`, plus the `logAndConcealGet("grok", params)` GET export.
- `lib/provider-validation.ts:24` — `grok: { url: "https://api.x.ai/v1/models", headers: { authorization: ... } }`.
- `lib/provider-rollout.ts:5-22` — add `GROK_RUN_ENABLED` to the bindings type and the `flags` record.
- `wrangler.jsonc` vars — `"GROK_RUN_ENABLED": "false"` with a one-line comment mirroring `GLM_RUN_ENABLED`'s.
- `.env.example` — `XAI_API_KEY=` next to `ZAI_API_KEY=`. Naming rule holds: secrets are named for the vendor account, flags for the provider id.
- `worker/agent-run-workflow.ts` — **no change.** `usesClaudeRunner` already parametrizes the gateway path (`:351`) and the JWT operation (`:322`).
- `credentialKindsForProvider` — **unchanged**, returns `["api_key"]` for grok, unless G4 passed. `credentialKindLabel`'s `"subscription"` fallback already covers a future grok oauth row.
- `RUN_SANDBOX_IMAGE_VERSION`: **no bump** — unless G1 step 6 saw a `claude-*` model id, in which case the alias passthrough fires, `scripts/claude-runner.mjs` changes, and `v4 → v5`.

## §B. If G2 passes — Grok via Chat Completions

Only reachable after a pin bump (fact 3). Everything in §A applies except the gateway:

- **Extract `lib/responses-gateway.ts` anyway** (see §C) — it is the right home for a second Codex-shaped route regardless of wire.
- The route's allowed path is `chat/completions`, not `responses`. Upstream `https://api.x.ai/v1/chat/completions`. This is a **different route shape** from the OpenAI gateway, so the extracted helper takes `allowedPaths: ReadonlySet<string>` + `upstreamBase`, not a single `upstreamUrl` — mirroring how `handleAnthropicCompatProxy` is already parametrized.
- `scripts/codex-runner.mjs:148` gains a provider-conditional `config` block carrying the `model_providers.<id>` table and `model_provider`. **That is a `COPY`'d script change: bump the image version.** Branch it by provider so `openai` runs are untouched.

## §C. If G3 passes — Grok via Responses (the design the decision log named)

- **Extract `lib/responses-gateway.ts`** from `app/runtime/openai/[...path]/route.ts` **as its own reviewable commit**, before the grok route exists. Config: `{ operation, provider, upstreamUrl, serverKeyBinding, forwardRequestHeaders: readonly string[] }`. Behavior must be **byte-identical**: same 404-on-missing-token, run-status join, 10 MiB double check (`content-length` then `byteLength`), `parts[0] === "v1"` normalization, single-segment path check, `resolveRunProviderSecret` call, oauth refusal (it *moves*, it does not disappear), and response-header allowlist (`content-type`, `cache-control`, `openai-processing-ms`, `x-request-id`) plus `x-content-type-options: nosniff`.
  **Proof of identity: `tests/worker/credentials.test.ts:319-384`, `:833-852`, and `:854-874` must pass untouched.** Do not edit a single assertion in those blocks in the extraction commit. If one needs editing, the extraction was not byte-identical — fix the code, not the test.
- New `app/runtime/grok/[...path]/route.ts`: `operation: "grok"`, `upstreamUrl: "https://api.x.ai/v1/responses"`, `serverKeyBinding: "XAI_API_KEY"`. `forwardRequestHeaders` grown from fact 6's observed list, and only from it — grow allowlists from evidence.
- Add `export function usesCodexRunner(provider): boolean` returning true for `openai` and `grok`, and **replace the workflow's implicit "everything else is Codex" fallbacks** (`worker/agent-run-workflow.ts:322`, `:344`, `:349`) with explicit branches, so a future provider cannot silently inherit the Codex path. This is the one workflow change §C carries.
- `worker/agent-run-workflow.ts:376` — keep the `OPENFLOOR_OPENAI_*` variable names, parametrized to `${origin}/runtime/${context.provider}/v1`, with a comment saying the name is the runner's **wire protocol**, not the vendor (the Kimi precedent: Kimi reuses `OPENFLOOR_ANTHROPIC_*`).
- `features.collab=false` and any `modelReasoningEffort` override are `scripts/codex-runner.mjs` changes ⇒ **image bump**, branched by provider so `openai` keeps today's behavior.
- Accept the WebSocket cost knowingly: fact 6 records five upgrade attempts (~7s) before HTTPS fallback on every thread. A POST-only gateway always incurs it. Record it in the decision log rather than engineering around it.
- Skills and MCP servers stay off for Grok, exactly as for Codex today. `SessionScreen.tsx` gates on `enabledProviders.some(usesClaudeRunner)` — **verify, do not change.**

## §Fail — what the commit contains if Gate G fails again

One docs-and-comment commit. No code, no route, no flag, no secret, no test flip.

1. **`AGENTS.md` decision-log entry**, appended at the end, in the established style — e.g. `### 2026-08-26 — Grok stays excluded: the chat wire is gone from the pin and the two known routes are unchanged`. Decision / Rationale / Consequences, matching `:1683` and `:1723`:
   - **Decision:** Grok still does not ship. No provider id, credential row, flag, or gateway route. `tests/unit` keeps pinning `parseCredentialProvider("grok") === null`.
   - **Rationale:** whichever of G1/G2/G3 were run, with exact statuses and error bodies. Include the binary-string evidence for fact 3 verbatim, since it is the cheapest citation anyone will need next time. Include G4's answer.
   - **Consequences:** name the *specific* conditions that reopen each route, so the next revisit is a checklist and not a re-derivation: (a) xAI accepting `role: "system"` in `messages[]` → §A, ~20-line route, no image bump; (b) `wire_api = "chat"` reinstated in a Codex pin → §B; (c) xAI tolerating `content: null` on replayed reasoning input items, or a Codex pin ceasing to emit it, or reasoning effort `none` suppressing replay → §C, with the pin-bump cost stated. Re-bank fact 6's model ids and header list so they are not re-derived.
2. **`docs/agent-backend-gaps.md:28-30`** — update the "Grok (xAI) — excluded twice" section to three, adding the chat-wire closure with its citation.
3. **`lib/provider-credentials.ts:5-9`** — extend the comment to name all three closed routes, with the date. This comment is load-bearing: it is what a future contributor reads before proposing route four.
4. Optionally `docs/glm-grok-subscription-provider-prompt.md:67` — append the new outcome under Spike B's existing `> Outcome` block, keeping that doc the single standing brief.

`npm test` is green by construction. Nothing deploys.

## §Tests (only if Gate G passes)

- **`tests/unit/provider-credentials.test.ts:28`** — flip `.toBeNull()` to `.toBe("grok")`. Keep `"mistral"` as the unknown-provider string here and in `tests/unit/validation.test.ts` and `tests/render/credentials.test.ts`.
- Same file: add `providerLabel("grok") === "xAI"`, `AGENT_PROVIDER_LABELS.grok === "Grok"`, `usesClaudeRunner("grok")` (`true` for §A, `false` for §B/§C), and — for §B/§C — `usesCodexRunner("grok") === true` **and `usesCodexRunner("gemini") === false`** (the assertion that stops a future provider silently inheriting the Codex path). Add the new default model id, and keep the `PROVIDER_MODELS[p][0] === DEFAULT_PROVIDER_MODELS[p]` drift guard passing for every provider including grok.
- **`tests/worker/credentials.test.ts`** — grok gateway cases mirroring the glm ones at `:616-695`: happy path asserting the exact upstream URL and Bearer header, owner-before-server resolution, wrong-operation JWT → 404, disallowed path → 404. **This file, not a new one** — `package.json:15` enumerates `test:worker`. Also widen the `connectKey` provider union at `:39`.
- **§C only** — the extraction commit adds nothing here. Its whole proof is that `:319-384`, `:833-852`, and `:854-874` pass unmodified.
- **`tests/worker/routing.test.ts:308`** — add a `grok` agent to the mixed-provider queue and assert it is per-item **skipped** while gated, never session-holding.
- **`tests/render/credentials.test.ts:9-11, 92-116`** — add `ACCEPTED_GROK_KEY` to `OPENFLOOR_TEST_PROVIDER_KEYS` and exercise connect/disconnect through the same loop.

`npm test` green on every commit.

## §Sequencing (one commit per line, `npm test` green each)

1. Spike G1 → G2 → G3, stopping at the first pass. G4 in parallel. Report before anything lands.
2. **Gate G fails** → the single §Fail docs commit. Close ENG-118 as documented-refusal.
3. **§C only, and only if a pin bump is required:** commit the bump — `@openai/codex-sdk` in `package.json` + `Dockerfile.sandbox:7`, `RUN_SANDBOX_IMAGE_VERSION` → `v5`, any new runner config branched by provider. **Deploy this alone and run the existing `openai` provider's full-arc acceptance** before anything Grok-shaped lands on top of it.
4. **§B/§C only:** commit the `lib/responses-gateway.ts` extraction + the OpenAI route rewritten as a thin caller. Its own reviewable step, because it is the one change here that touches a route already carrying production traffic.
5. Commit — Grok: provider id + labels + models + runner predicate + route + validation entry + flag at `"false"` + `.env.example` + tests + the `tests/unit` un-pin + `AGENTS.md` maintenance (implemented list `:184`, flags, secrets adding `XAI_API_KEY`, `docs/agent-backend-gaps.md:28-30` rewritten from "excluded" to "shipped behind a gate", `docs/github-production.md`'s secrets runbook) + a decision-log entry recording which route won and its wire evidence.
6. Deploy. Then the acceptance runbook. Then a separate flag-flip commit.

## §Acceptance — `GROK_RUN_ENABLED` flag-flip runbook

Keep it `"false"` until, in order:

1. The deploy containing its code is live via `wrangler deploy` (plus the bumped image, for §B/§C).
2. A credential resolves — `npx wrangler secret put XAI_API_KEY`, or a test user has connected an owner key in Settings.
3. A staging session runs the full arc: create a Grok agent, queue a trivial "create a file" item, verify run start → streaming activity events → files collected → checks run → publish → serialized integration → `providerThreadId` recorded. **For §C the pass condition is specifically a multi-turn thread** — a single-turn success is exactly what the failed spike already achieved.
4. Review that run's gateway logs: every rejected path is either added to the allowlist with the log line cited in the commit, or confirmed safe to refuse. Confirm no request carried a `claude-*` model id (§A), and that traffic hit only the expected path (`messages` for §A, `responses` for §C, `chat/completions` for §B).
5. Flip the var in `wrangler.jsonc`, deploy, and update AGENTS.md's flag section and decision log in the same commit. Rollback = flip back; existing grok agents persist and degrade correctly (routing skips, manual starts refuse, creation refuses).

## §Out of scope (each gets a `docs/agent-backend-gaps.md` line)

- Any gateway that edits a request body or a message role. Permanently rejected; three separate briefs now depend on it.
- openfloor operating an OAuth login flow against xAI. Standing decision.
- Grok subscription credentials, if G4 answers no — recorded as a refusal with its evidence, not as a deferral.
- A fourth integration route via a hypothetical first-party xAI coding CLI (the Gemini-runner recipe: new runner + own standalone gateway). **Unverified that one exists** — establish that before anyone designs it. Priced as the most expensive route by construction: a new `scripts/*-runner.mjs`, a new settings builder, a new sandbox posture gate, a Dockerfile line, and an image bump.
- Token and cost metering; subscription quota display. Unchanged.

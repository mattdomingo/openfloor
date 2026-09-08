> Historical implementation plan. The 2026-09-08 personal-billing decision supersedes server-key fallback and subscription enablement described below. Current execution accepts personal API keys only; see AGENTS.md and the API contracts.

# Task: accept a Moonshot (Kimi) coding-subscription credential alongside API keys — ENG-120

You are working in the openfloor repo, on branch `ali/eng-120-kimi-plan-usage`, branched off `main`. Read `AGENTS.md` completely first — its "Mandatory maintenance rule" (AGENTS.md:7) applies to every commit here, **including a refusal commit**. `docs/glm-grok-subscription-provider-prompt.md` §1 and §4 are the precedent briefs; §4 (Claude setup tokens) is the design you are copying.

Linear ENG-120: *"Kimi usage is only API, import plan usage capabilities (if possible)."*

openfloor runs coding agents in a sandbox against a member's own provider credential. Today a Kimi run bills that member's pay-as-you-go Moonshot API key. This ticket asks whether it can instead bill a Moonshot coding **subscription** the member already pays for — the same thing §4 shipped for Claude Pro/Max seats.

The ticket says "if possible", and Moonshot's subscription credential shape is **unverified in this repo**. So this is a Step-0 spike with a hard decision gate and a conditional build behind it. A documented refusal is an acceptable outcome, exactly as it was for Grok.

## What exists today — build none of it again

The credential-kind machinery this ticket needs is already live. Nothing here adds a table, a column, a migration, or a concept.

- `lib/provider-credentials.ts:17` — `CREDENTIAL_KINDS = ["api_key","oauth"]`. `:34` `credentialKindsForProvider` returns both kinds for `anthropic` only.
- Rows are keyed `(user_id, provider, kind)`, AES-256-GCM at rest, upserted `ON CONFLICT(user_id, provider, kind)` (`db/provider-credentials.ts:87`). `db/schema.ts` keeps `provider` and `kind` as TS-only enums with **no SQL CHECK**, so a new kind on an existing provider needs no `db:generate` and **no migration**.
- `lib/provider-credentials.ts:49` — `credentialAadContext` binds the bare legacy `<userId>:<provider>` for `api_key` and `<userId>:<provider>:<kind>` for every other kind. A new `oauth` row gets the kinded AAD for free.
- `db/provider-credentials.ts:171` — `resolveRunProviderSecret`, the single credential ladder every gateway calls. It already refuses three ways rather than switching payer: unreadable ciphertext, a row of a kind the provider disallows (`:184`), and an agent naming a kind its owner has not connected (`:202`, `missing_selected_kind`).
- `lib/anthropic-compat-gateway.ts:18` — `AnthropicCompatGatewayConfig`. `upstreamBase` (`:23`) is a **static string**. `buildAuthHeaders` (`:31`) is **already kind-aware**: `(secret, kind) => Record<string,string>`. `oauthBetaFlag` (`:37`) is the existing precedent for "one optional field that only applies to oauth-kind resolutions", consumed at `:83`.
- `app/runtime/kimi/[...path]/route.ts` — 23 lines over that handler. `upstreamBase: "https://api.moonshot.ai/anthropic/v1"`, Bearer auth, allowlist `messages` + `messages/count_tokens`.
- `lib/validation.ts:296` — `parseCredentialConnectInput` already accepts `{ setupToken }`: an opaque token, ≤512 chars, rejecting embedded whitespace and control characters. That is exactly the paste-error check a pasted plan token wants. **No validation change is needed.**
- `components/product/ProviderCredentials.tsx:41-42` already iterates `providers × credentialKindsForProvider(provider)`; `CreateAgentDialog.tsx:117` and `AgentCard.tsx:107` render the Billing field whenever a provider has more than one kind. **Widening a provider's kinds lights all of that up with zero UI code.**

The useful consequence: if Moonshot's plan credential is a pasteable opaque token consumed as a bearer against an Anthropic-compatible surface, **this entire ticket is one function's return value plus, at most, one optional config field.**

## Verified vs unverified

| # | Statement | Status |
|---|---|---|
| 1 | Moonshot's pay-as-you-go Anthropic-compat surface is `https://api.moonshot.ai/anthropic/v1`, auth `authorization: Bearer <sk-…>`, SSE framing Anthropic-exact, `count_tokens` 404s upstream, `/v1/models` lists bare `kimi-k3`. | **Verified in-repo** (Spike A, 2026-08-24 decision log; production acceptance same day). |
| 2 | Kimi runs execute `scripts/claude-runner.mjs` unchanged; the workflow parametrizes only `/runtime/${provider}` and the JWT operation. | **Verified in-repo.** |
| 3 | Moonshot sells a coding subscription and documents using it with Claude Code via `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`. | **Unverified here.** Do not assume the product name, price, credential shape, base URL, or that it still exists in this form. |
| 4 | The plan credential is a different string from a PAYG key, and/or is sent to a different base URL. | **Unverified — this is the whole ticket.** |
| 5 | The plan credential is *pasteable* — a string copied from a console or CLI, rather than an interactive browser login depositing a rotating bundle on disk. | **Unverified and gating.** |

Rows 3–5 must come from the spike. Do not write a line of code against a remembered endpoint.

## Step 0 — Spike K. Report before any code lands.

**Prerequisite:** an actual Moonshot coding subscription on a scratch account, **plus** the existing scratch PAYG key. Buy the cheapest tier. Both credentials must be in hand simultaneously — K6 is unanswerable otherwise.

No repo changes, no deploy. Steps 1–8 with `curl`; step 9 with the repo's real runner.

**K1 — Is there a pasteable credential at all?**
Complete the purchase and inventory what the account hands you. Record literally: the console page or CLI command that produces the credential; whether it is a copyable string; its prefix and length; whether it is minted per-device or once; whether it expires and when. **If the only path to the plan is an interactive browser login that writes a rotating token bundle to disk, stop — Gate K fails.**

**K2 — What does the vendor's own guide say, for the subscription?**
Find Moonshot's instructions **for the plan**, not the PAYG guide already banked in this repo. Record verbatim the `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` values they tell you to set, and the recommended model id. This single answer sizes the whole ticket:
- Base URL identical to `https://api.moonshot.ai/anthropic` → **the code change is `credentialKindsForProvider` and nothing else.** Say so loudly in the report.
- Base URL different → add `oauthUpstreamBase` (below). Still small.

**K3 — Auth shape.** `POST <planBase>/v1/messages` with `authorization: Bearer <planToken>`, `anthropic-version: 2023-06-01`, `content-type: application/json`, a trivial 64-token message. Repeat with `x-api-key: <planToken>`. Record which header(s) authenticate, and which model ids the plan actually serves — a coding plan may not serve every id in `PROVIDER_MODELS.kimi`.

**K4 — Streaming.** Same request with `"stream": true`. Confirm Anthropic SSE framing (`message_start` / `content_block_delta` / `message_stop`). The Claude Agent SDK is the consumer; anything else is a fail.

**K5 — `count_tokens`.** `POST <planBase>/v1/messages/count_tokens`. Record the status. A 404 is fine — the PAYG surface already 404s, and the allowlist forwards it so the CLI degrades on the vendor's answer rather than on our concealment.

**K6 — The 2×2 cross-check.** Send all four and record every status, plus (where 200) any indication of which ledger was charged:

| | PAYG base | plan base |
|---|---|---|
| **PAYG key** | control | ? |
| **plan token** | ? | ? |

Two findings fall out:
- If **plan token → PAYG base** works, the base-URL split is cosmetic. Ship without `oauthUpstreamBase`.
- If **PAYG key → plan base** works, connect-time validation **cannot distinguish the two credentials**. That is an accepted limit, not a bug to engineer around: a member who pastes their PAYG key into the plan slot gets silently billed per token. Both credentials belong to the same member and bill the same member, so the consequence is a surprising invoice, not a security failure. Mitigate with copy — name the exact console page in the Settings row — not with code. This mirrors the existing accepted limit that `PROVIDER_MODELS` is per provider, not per credential.

**K7 — Free validation probe.** `GET <planBase-or-console>/v1/models` and `https://api.moonshot.ai/v1/models` with the plan token. A 200 means `validateProviderOauthSecret` gets a `kimi` case and the row stores a real `validated_at`. Anything else means the `null` return stands, the row reads "Connected — not yet verified", and the first run is the real validation. **Do not fake a timestamp.**

**K8 — Rate-limit shape.** Record response headers on a 200, and on a limit response if you can provoke one cheaply. The compat handler already forwards `retry-after` and the whole `anthropic-ratelimit-*` prefix (`lib/anthropic-compat-gateway.ts:95`). If Moonshot signals plan utilization under a different prefix, that is a one-line addition to the same allowlist. If it signals nothing, say so — the run then fails on the vendor's status code alone, which is honest and acceptable.

**K9 — End to end, production shape minus the gateway.** In a scratch git workspace, behind a local logging proxy:

```
OPENFLOOR_ANTHROPIC_BASE_URL=<planBase> OPENFLOOR_ANTHROPIC_TOKEN=<planToken> \
OPENFLOOR_MODEL=<planModel> OPENFLOOR_PROMPT_PATH=… OPENFLOOR_RESULT_PATH=… \
OPENFLOOR_WORKSPACE=… node scripts/claude-runner.mjs
```

with a "create a file" prompt. Gate on: the run completes, a file is actually edited, `result.json` has `ok: true`. Log every request path and **every model id in every request body** — a `claude-*` id means the model-alias env passthrough is needed, which is a `scripts/claude-runner.mjs` edit and therefore an image bump.

### Gate K

**PASS** iff K1 yields a pasteable string **and** K9 completes with `ok: true` and no `claude-*` model ids. K2–K8 record parameters; they do not gate.

**FAIL** if K1 finds no pasteable credential, or K9 fails on a wire incompatibility that no *header* substitution fixes. Do not fix a body-shape incompatibility in the gateway — body rewriting is a standing rejected shim (it is what excluded Grok, twice).

State explicitly in the report whether the delta is base-URL-only, because that determines whether the diff is one function or two.

## Code changes if Gate K passes

One commit. No flag (this changes an existing provider's credential handling, exactly like §4). No migration. No runner change. No Dockerfile change. **No `RUN_SANDBOX_IMAGE_VERSION` bump**, unless K9 surfaced `claude-*` traffic.

**`lib/provider-credentials.ts`**
- `credentialKindsForProvider` (`:34`): `kimi` joins `anthropic` in returning `CREDENTIAL_KINDS`. **Keep `openai`, `gemini`, `glm` at `["api_key"]`** — the openai narrowing has its own decision-log entry and must not be collaterally widened.
- `credentialKindLabel` (`:40`): add a `kimi` case returning the plan's real name from K1 (the current fallback returns a generic `"subscription"`). This string is what the Settings row and the `missing_selected_kind` refusal message say, so it must be a name the member recognizes from their invoice.
- `CREDENTIAL_SETUP_COMMANDS` (`:99`): add `"kimi:oauth"` **only if K1 found a CLI command that mints the token**. If the member copies it from a console page instead, leave the entry absent — the Settings form already branches on its presence.
- Update the block comment at `:29-33` so it no longer reads as "oauth is anthropic-only, openai pending §5".
- **Naming debt, stated rather than hidden:** a Moonshot plan token is very likely not an OAuth token in any literal sense. Reusing the existing `oauth` kind is nonetheless right — a third `CREDENTIAL_KINDS` member would touch the AAD function, both label functions, `parseCredentialConnectInput`, the Settings form, the Billing selector, `db/floor.ts:427`, and every `kind === "oauth"` branch in two gateways, all to encode a distinction only one line of gateway code cares about. Add a one-line comment at `:17` saying `oauth` is the second-credential slot ("the member's own subscription seat"), not a claim about the token's protocol, and record the same sentence in the decision log.

**`lib/anthropic-compat-gateway.ts`** — only if K2/K6 showed a different base URL.
- Add one optional field beside `oauthBetaFlag`:
  ```ts
  // Upstream prefix used INSTEAD of upstreamBase when the resolved credential
  // is kind oauth — a vendor whose subscription seat is served from a
  // different host/path than its pay-as-you-go keys.
  oauthUpstreamBase?: string;
  ```
- One line at the fetch (`:87`): pick `resolved.kind === "oauth" && config.oauthUpstreamBase ? config.oauthUpstreamBase : config.upstreamBase`.
- **Explicitly rejected alternative:** making `upstreamBase` a `(kind) => string` function. It generalizes a two-branch decision into a callback at every call site, forces all four existing routes to change shape for one new consumer, and buys nothing the optional field does not. The optional-field form also mirrors `oauthBetaFlag` exactly, so the config type stays readable as "static config, plus the deltas that only apply to a subscription credential". If a third vendor ever needs a third upstream, revisit then.

**`app/runtime/kimi/[...path]/route.ts`**
- `oauthUpstreamBase: "<planBase>"` if K2/K6 demanded it.
- `buildAuthHeaders` gains a kind branch **only if K3 showed the plan token needs a different header**. If it is `Bearer` for both — the likely case — leave the existing single-argument form and add a comment saying the kind is deliberately ignored because both credentials authenticate identically.
- Extend the header comment at `:3-7` with the K3/K5/K6 findings, in the style the anthropic route uses.

**`lib/provider-validation.ts`**
- `validateProviderOauthSecret` (`:41`): if K7 found a probe, turn the `provider !== "anthropic"` guard into a per-provider probe map entry for `kimi`, keeping the `testAcceptedKeys` adapter branch working for both. If K7 found no probe, **change nothing** — `null` is already the correct answer.

**`components/product/ProviderCredentials.tsx`**
- The `field` resolution at `:82` already yields `"setupToken"` for a non-openai oauth row, which is the right PUT field. **No change there.**
- The help copy at `:164-172` says "Run this on your machine and paste the token it prints", which is wrong when there is no command. Make that sentence conditional on `setupCommand` being present; the else branch points at the plan console (reuse `PROVIDER_KEY_GUIDE[provider].consoleUrl`, or add a plan-specific URL if K1 found the credential lives elsewhere).
- The label at `:194`/`:196` reads "Setup token"; generalize to the kind's own noun.

**No change** to: `lib/validation.ts`, `db/*`, `worker/agent-run-workflow.ts`, `Dockerfile.sandbox`, `wrangler.jsonc`, `.env.example`, `lib/runtime-token.ts`, `lib/provider-rollout.ts`, `CreateAgentDialog.tsx`, `AgentCard.tsx`, `db/floor.ts`.

## Tests — read this section twice

**Two existing negative tests use `kimi` as their "provider that refuses a subscription kind" example.** Widening Kimi silently guts both. Re-point them at `gemini` or `glm` **in the same commit**, and update their inline comments (one names Moonshot):

- `tests/worker/credentials.test.ts:800` — *"refuses an oauth credential on a provider that does not allow the kind"*
- `tests/render/credentials.test.ts:163` — *"Providers without a subscription kind refuse it"*

Losing those is the single most consequential silent regression available in this ticket: they are what prove a hand-written row of a disallowed kind never reaches a vendor and never falls through to the server key.

Then:

- **`tests/unit/provider-credentials.test.ts`** — `:118` flips to `["api_key","oauth"]`; **keep `:117`, `:119`, `:120` pinned**. Add `credentialKindLabel("kimi","oauth")` and `credentialAadContext("user-1","kimi","oauth") === "user-1:kimi:oauth"` (proving the kinded AAD covers the new provider while an `api_key` kimi row keeps the bare legacy form). Update `:193` per K7's answer.
- **`tests/unit/validation.test.ts`** — `:119` flips: `parseAgentInput` now yields `credentialKind: "oauth"` for kimi. **Keep `:120` and `:121`** (gemini, glm) returning `null`.
- **`tests/worker/credentials.test.ts`** — no new file (`package.json:15` enumerates `test:worker` by name; a new file silently never runs). Parametrize the `kindAgentRun` helper at `:103`, which hardcodes `provider: "anthropic"`, with a defaulted argument so existing callers are untouched. Then add, mirroring `"bills exactly the credential kind each agent names, through the gateway"` (`:697`): one owner holding **both** a kimi `api_key` and a kimi `oauth` row, two agents with different `credential_kind`, both runs through `postKimiGateway`; assert each request's URL and auth-header form and the absence of the other form. Add a comment saying the URL assertion encodes a spike finding. Then the disconnect refusal, reusing the shape at `:751-758`: delete the oauth row, set `MOONSHOT_API_KEY`, assert the plan-bound agent gets `503` containing *"…which is not connected"* **while the api_key agent still gets 200**, and `fetchSpy` was not called for the refused one. That is the assertion that stops a disconnected subscription from silently billing openfloor.
- **`tests/render/credentials.test.ts`** — a kimi plan connect alongside a kimi API key via the `OPENFLOOR_TEST_PROVIDER_KEYS` adapter; assert the deterministic `ORDER BY provider, kind` listing and that `DELETE ?kind=oauth` removes only the plan row. Template at `:119`.

`npm test` green on the commit.

## If Gate K fails — one docs-only commit, no code

1. **`AGENTS.md` decision-log entry**, dated, titled in the Grok mold. Three sections, house format:
   - **Decision:** `credentialKindsForProvider("kimi")` stays `["api_key"]`; no plan credential, no second upstream.
   - **Rationale:** the empirical findings at the specificity the Grok entries use — exact status codes, exact error bodies, the full K6 2×2, and which single observable is fatal. If K1 failed, say precisely what the login flow deposits and why that is the same problem as a rotating credential bundle.
   - **Consequences:** what would have to change upstream for a revisit (a documented pasteable token, or a plan base URL that accepts a console-minted key), and the facts banked for that day — the plan's accepted models, auth headers, rate-limit header family, whatever K2–K8 produced before the fatal step. A failed spike that banks its measurements is worth most of a passed one.
2. **`docs/agent-backend-gaps.md`** — one sentence appended to the "Credential kinds — deliberately deferred pieces" paragraph (`:26`), naming Kimi plan usage and citing the decision-log date. If the failure is structural on more than one route, give it its own `##` section the way the Grok exclusion has one.
3. **Pin the negative.** `tests/unit/provider-credentials.test.ts:118` already asserts `["api_key"]`; add a comment citing the decision-log date, the way `parseCredentialProvider("grok") === null` is pinned, so a future partial add fails loudly rather than half-shipping.

`npm test` stays green; nothing but docs and a comment changed.

## Invariants

- **No request-body or role rewriting in any gateway.** Headers may be substituted; bodies may not be edited.
- **No subscription credential is ever a server fallback.** Server bindings are plain strings and are `api_key` by construction. openfloor never operates one member's seat on behalf of others.
- **Never fall back from a present-but-broken owner credential to the server key**, nor from a named-but-unconnected kind to the other kind.
- **Per-item skip, never a session-wide hold.**
- **Bump `RUN_SANDBOX_IMAGE_VERSION`** (`worker/agent-run-workflow.ts:82`, currently `"v4"`) in any commit touching `Dockerfile.sandbox` or a `COPY`'d script.
- **No metering, no quota display.** openfloor has no authoritative source for a member's remaining plan usage and will not invent one.
- **AGENTS.md maintenance in the same commit** (`AGENTS.md:7`); superseded text is marked superseded, never deleted (`AGENTS.md:19`).

## Sequencing

1. **Spike K.** Report before any code. Needs a purchased subscription; nothing else. No deploy.
2. **Commit 1 (pass):** everything above in one commit — there is no migration, no flag, and no deploy-ordering hazard, so splitting buys review noise, not safety. `npm test` green.
   **Commit 1 (fail):** the docs-only refusal.
3. **Deploy.** No flag flip; `KIMI_RUN_ENABLED` is already `"true"` and this ticket does not touch rollout.
4. **Acceptance runbook** (the §4 shape, not the per-provider flag shape):
   - Connect a Kimi plan credential **alongside** a Kimi API key on one member.
   - Create two agents owned by that member, one `credential_kind: "api_key"`, one `"oauth"`.
   - Run both. From the Worker tail, confirm each run's `/runtime/kimi/v1/messages` request went to the base URL its agent's kind selects, with the auth form the spike recorded, and that **no request carried a `claude-*` model id**.
   - Disconnect the plan credential. Confirm the plan-bound agent refuses with the actionable message and the API-key agent keeps running.
   - Confirm no rejected-path warnings appeared; if any did, either allowlist them citing the log line or confirm the refusal is correct.

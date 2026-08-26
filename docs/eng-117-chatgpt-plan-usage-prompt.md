# Task: accept a ChatGPT-subscription credential for Codex runs — ENG-117

You are working in the openfloor repo, on branch `ali/eng-117-openai-plan-usage`, branched off `main`. Read `AGENTS.md` completely first — its "Mandatory maintenance rule" (AGENTS.md:7) applies to every commit here, **including a refusal commit**.

Linear ENG-117: *"OpenAI usage is only API, import plan usage capabilities (if possible)."*

openfloor runs coding agents in a sandbox against a member's own provider credential. Today an `openai` run bills that member's OpenAI API key. This ticket asks whether it can instead bill a ChatGPT subscription the member already pays for — the same thing shipped for Claude Pro/Max seats in `docs/glm-grok-subscription-provider-prompt.md` §4.

**This ticket is that brief's §5, made executable.** Read §5 and §4 before anything else. §5's own author wrote *"expect this one to fail"*. Treat that as a design input rather than pessimism: everything below is arranged so a refusal costs exactly one docs commit.

## What already exists, §5-ready — build none of it

- `lib/validation.ts:296-326` — `parseCredentialConnectInput` already accepts `{ authJson }`: ≤8192 chars, `JSON.parse`d, shape-checked for `tokens.account_id` + `tokens.access_token` (both non-empty strings), stored verbatim so unknown fields round-trip, and **fingerprinted by `account_id`, never by any token in the bundle**.
- `components/product/ProviderCredentials.tsx:81, 162-206` — the dormant bundle form: `bundle = provider === "openai" && kind === "oauth"`, a `<textarea maxLength={8192}>`, the `codex login` copy command from `CREDENTIAL_SETUP_COMMANDS` (`lib/provider-credentials.ts:99-102`), an "account ····XXXX" connected state, `autoComplete="off"` + `spellCheck={false}`.
- `lib/provider-credentials.ts:34-36` — `credentialKindsForProvider` returns both kinds for `anthropic` only. **This single line is the withholding.**
- `app/runtime/openai/[...path]/route.ts:35-45` — the oauth refusal, explicitly labeled defense in depth for hand-written rows. Pinned by `tests/worker/credentials.test.ts:833-852`.
- `db/provider-credentials.ts:171-209` — the one credential ladder. `:184-190` refuses a kind the provider does not allow, before any header is built, without falling through to the server key.
- `db/schema.ts:224` `floor_agents.credential_kind`; `:854` `user_provider_credentials` keyed `(user_id, provider, kind)` (migration `0030`). **No migration in this ticket.**
- `db/floor.ts:427-441` — the billing PATCH, with a `409` while a run is in flight.
- `worker/agent-run-workflow.ts:364-366` — the workflow already decrypts credentials (MCP server headers) and passes them into the container env. So "a decrypted secret reaches the container" is not novel. What *is* novel is the scope: an MCP header is a token the owner minted for one integration; a ChatGPT bundle is their account. That precedent lowers the architectural bar, not the risk bar.
- `worker/agent-run-workflow.ts:154` — prepare runs `rm -rf /tmp/openfloor` every run, so a `CODEX_HOME` under that tree is wiped between runs by machinery that already exists.
- `worker/agent-run-workflow.ts:411` — the "wait for Codex" step timeout, **60 minutes**. This is the number D1 measures against. (§5 cites `:337`; stale.)
- `Dockerfile.sandbox:7` pins `@openai/codex-sdk@0.148.0`. `RUN_SANDBOX_IMAGE_VERSION` is `"v4"` (`worker/agent-run-workflow.ts:82`) — §5 says v3; stale.

## Two corrections to §5 you must carry

**Correction 1 — ~~§5's Spike D step 2 names the wrong config key.~~ WITHDRAWN: this correction was itself wrong, and §5's step 2 was right all along.** *(Rewritten 2026-08-26 after Spike D measured it. Kept rather than deleted because it inverted the single fact the whole design turns on: a reader who believed it would build the gateway against the lever that moves no model traffic.)*

~~The SDK's `baseUrl` option only ever emits `openai_base_url`, so `chatgpt_base_url` is reachable only through the SDK's `config` override. §5 asks whether the CLI honors `openai_base_url` in ChatGPT mode; that is very likely the wrong question.~~

What is actually true, measured against the pinned `@openai/codex-sdk@0.148.0`:

- **`openai_base_url` is the MODEL-traffic lever, and it keeps working in ChatGPT auth mode.** That is exactly what §5 asked, and the answer is yes. It is also already wired: `scripts/codex-runner.mjs` sets it from `OPENFLOOR_OPENAI_BASE_URL` through the SDK's `baseUrl`, so the model path needs **no runner change**.
- **`chatgpt_base_url` is the NON-MODEL lever.** The key genuinely exists (the binary-string inspection was right about that much), but it governs only the plugins, analytics, settings, and MCP-marketplace surface — `/ps/plugins/*`, `/codex/analytics-events/events`, `/api/codex/settings/user`, `/api/codex/ps/mcp`. Pointing it at a gateway moves **zero** model requests. In ChatGPT auth mode it is worth setting so telemetry stays in; in the API-key auth mode this ticket ships, that surface is a single `GET /plugins/featured` and reaching it would cost a runner change, so it is deliberately left alone.
- Neither override covers everything: `ab.chatgpt.com` and `github.com` are contacted regardless. That is pre-existing behavior of every Codex run today, not something this ticket introduces.

**Correction 2 stands, and is load-bearing in the opposite direction from how it reads.** The SDK sets `CODEX_API_KEY` only if `apiKey` is truthy (`dist/index.js:246`) — and because today's runner always passes it, the CLI is always in **API-key** auth mode. That turned out to be the shipping design: the gateway substitutes a ChatGPT bearer plus `chatgpt-account-id` onto an API-key-mode request, `https://chatgpt.com/backend-api/codex/responses` answers **200**, and no bundle is written into the container at all. The "omit `apiKey`" conditional this correction anticipated is therefore **not needed**, and neither is `CODEX_HOME`, `forced_login_method`, or an image bump.

## Verified vs unverified

| # | Statement | Status |
|---|---|---|
| 1 | OpenAI documents a CI/CD path for ChatGPT-subscription Codex: `codex login` on a trusted machine, copy `~/.codex/auth.json` (location via `CODEX_HOME`), set `cli_auth_credentials_store = "file"`. ~~Codex refreshes when `last_refresh` is older than ~8 days~~, and on a `401`, writing rotated tokens back to the file. | Doc path verified 2026-08-24 (learn.chatgpt.com/docs/auth/ci-cd-auth). **Refresh trigger CORRECTED 2026-08-26 by Spike D: refresh is `401`-driven, not file-age-driven.** A bundle with a 12-day-old `last_refresh` but a still-valid access token triggered no refresh whatsoever — the file came back byte-identical (same inode, same mtime). openfloor's server-side refresh therefore keys on the token's own `exp`/`expires_in` (and `earliest_refresh_at`), never on file age. |
| 2 | The same page restricts the pattern to trusted private infrastructure and states **only one machine or serialized job stream may use a given `auth.json`** — concurrent users of one copy cause token-rotation conflicts. | Verified. An architectural constraint, not a caveat. |
| 3 | In ChatGPT-auth mode the CLI talks to `https://chatgpt.com/backend-api/codex/responses`. `CODEX_API_KEY` selects API-key mode instead. | Verified at doc level. |
| 4 | The pinned binary carries the whole `chatgpt_*` config cluster (see Correction 1). | **Verified in-repo, 2026-08-26.** |
| 5 | Access-token TTL; whether the CLI starts from a bundle with `refresh_token` removed; what the CLI validates locally about `tokens.access_token`; whether the run's own workspace can read `$CODEX_HOME/auth.json`; whether `srt` can wrap the Codex CLI. | **All unverified and all load-bearing. Spike D exists for exactly these.** |

## Step 0 — Spike D, in dependency order. Report before any code.

**Prerequisite:** a scratch ChatGPT-subscription `auth.json` from `codex login`, on a machine whose login you are willing to have invalidated — D4 deliberately forces a rotation, and that is a real cost of running this spike. Run against the **pinned** `@openai/codex-sdk@0.148.0`, because that is what the image ships. No deploy, no repo changes.

### D0 — try to keep the gateway in the request path, first

§5 assumes the credential must live in the container and then mitigates that. Correction 1 opens a strictly better shape §5 never considered, and it should be tested before anything else: if it holds, §5 collapses into §4's proven header-substitution design and both of §5's named hazards stop existing.

1. Start the CLI with `CODEX_HOME` = a temp dir holding a **real** `auth.json`, `cli_auth_credentials_store = "file"`, **no `CODEX_API_KEY`**, and `config: { chatgpt_base_url: "http://127.0.0.1:8788" }` through the SDK's `config` override. Point a local logging stub at that port.
2. Record whether model traffic reaches the stub, and on which path (`/backend-api/codex/responses` expected per fact 3 — the gateway allowlist is grown from **this observation**, not from the doc).
3. Repeat with `forced_login_method` set (read its accepted values first — `codex config` help, or observe the error from a deliberately wrong value). Establish whether it pins ChatGPT mode deterministically, so mode selection does not depend on the absence of an env var.
4. **The question that decides the whole design: does the CLI inspect `tokens.access_token`, or does it forward the string opaquely?** This is the same question `handleAnthropicCompatProxy` already answers for Claude setup tokens — the Claude runner holds a run-scoped JWT and never sees the real credential, because the CLI does not care what the string is.

   Establish it by starting the CLI against the stub with, in turn: (a) the real token past its `exp`; (b) a well-formed placeholder of the same shape that is not a live credential; (c) a malformed string. Record which of the three still start a turn and reach the stub, and record any local error the CLI emits before making a request — that error text is the evidence, since it tells you what the CLI checked.
   - **If (b) starts a turn:** the CLI forwards opaquely, so the container never needs a live credential. openfloor's gateway substitutes the real bearer per request, exactly as it does for a Claude setup token. Ship **Shape A**, and both of §5's hazards stop applying.
   - **If (b) is rejected locally:** the CLI inspects the token, so the bundle in the container must carry a real access token. The *refresh* token still need not — proceed to D2, and the credential's usable life in the container is then bounded by its TTL rather than being durable.
5. If step 2 shows the CLI ignoring `chatgpt_base_url` and going straight to `chatgpt.com`, also try `openai_base_url` (§5's original guess) for completeness, and record both answers. Then D5 is the only containment left.

### D1 — access-token TTL vs a full run

Decode the `access_token`; record its `exp` and derived TTL. Compare against the **60-minute** step timeout (`worker/agent-run-workflow.ts:411`).

The TTL is doubly load-bearing: it bounds how long a run can survive on a refresh-token-free bundle, **and** it bounds how long a credential present in a container remains usable at all. Record both readings.

Also record what the CLI does when the token expires **mid-turn** with no refresh token available: hard error, silent 401 loop, or graceful failure. A run that dies at minute 45 with an opaque error is a worse product than one that refuses at minute 0.

### D2 — does the CLI start without a refresh token?

Remove `tokens.refresh_token` from the bundle, set `last_refresh` to now, start the CLI. Record: runs / warns-and-runs / refuses / **silently falls back to API-key mode**. Test for the last one explicitly — it would mean a subscription-billed agent quietly billing an API key, which is the exact failure `resolveRunCredentialSource`'s `missing_selected_kind` branch exists to prevent.

### D3 — is the credential file readable from the run's own workspace?

Determine whether Codex's `workspace-write` sandbox permits the agent's shell to **read** `$CODEX_HOME/auth.json`. Assume yes until proven otherwise — `workspace-write` restricts writes, not reads.

Record the negative results too, so they are not re-proposed as fixes: the Codex CLI spawns the agent's shell as itself, so the `runuser` + `openfloor-agent` separation the Claude runner uses does not help (it drops *both* the CLI and its children to the same user). Placing `CODEX_HOME` outside the git worktree, under `/tmp/openfloor/` which prepare wipes at `:154`, keeps the file out of the **changed-path set** the publisher pushes, but does not make it unreadable.

### D4 — is the rotation write-back implementable? *(new; §5 asserts it without checking)*

Let the CLI actually rotate: use a bundle with `last_refresh` older than ~8 days, or force a `401`. Record:
- Does the CLI write the new bundle back to `$CODEX_HOME/auth.json`, or somewhere else?
- In place, or write-then-rename (in which case a naive read-back races)?
- Is the rewritten file readable by the workflow's `sandbox.exec`/file read after the process exits, given ownership?
- Does the rewritten bundle still parse under `parseCredentialConnectInput`'s shape check?

If §5 ships with the refresh token in the container (because D2 says the CLI refuses without it), the write-back is mandatory — a stale stored copy silently breaks every future run. If the refresh-token-free design holds, there is nothing to write back from the container and refresh happens server-side under D6.

### D5 — can `srt` wrap the Codex CLI?

Needed only if D0 fails, but run it regardless — it is the containment fallback and it is cheap.

Test the whole Codex runner `srt`-wrapped the way `gemini-runner.mjs` is (`worker/agent-run-workflow.ts:347`), with `chatgpt.com` and `auth.openai.com` allowed. The open question is nesting: the Codex CLI has its own kernel sandbox, and bubblewrap inside bubblewrap is not obviously fine. Note the Gemini precedent's residual (`AGENTS.md:1695`): Node 22's fetch ignores proxy env vars, which required `scripts/gemini-proxy-preload.mjs`. The Codex CLI is a Rust binary, so that specific preload does not apply — but whether its HTTP client honors `HTTP_PROXY` at all is the same class of question and **must be established, not assumed**.

### D6 — the serialization critical section

§5's analysis narrows fact 2 correctly and stands: two members' bundles never interact, and an access token is an ordinary bearer JWT, so concurrent runs sharing one are fine. **Only the refresh conflicts.**

Design consequence: refresh happens **server-side**, guarded by a conditional D1 (Cloudflare D1, not spike D1) update on the credential row —

```sql
UPDATE user_provider_credentials SET ciphertext = ?, updated_at = ?
 WHERE user_id = ? AND provider = 'openai' AND kind = 'oauth' AND updated_at = ?
```

— so two concurrent dispatches cannot both refresh, and the loser re-reads the winner's result. **A short critical section around one write, not a whole-run lock.**

Fall back to a real per-owner run lock **only if D2 shows the CLI refuses a refresh-token-free bundle.** In that case: **no new table.** Query `agent_runs` joined to `floor_agents` for another in-flight run (`running` / `cancel_requested` / `checking`) owned by that user on `openai` with `credential_kind = 'oauth'`, and treat a hit as a **per-item skip** in `runRoutingTick` (`db/routing.ts`, the existing `disabledProviders` shape) plus a `not_ready` at the manual-start seam. **Never a session-wide hold.**

## Gate D — what makes it FAIL

Ship only if **all** hold. Any single failure is "do not ship".

- **D-fail-1 — TTL.** The access-token TTL does not cover a full run under whichever bundle design survives D2, **and** the CLI's mid-turn expiry behavior is not a clean, actionable failure.
- **D-fail-2 — no containment.** The CLI honors **neither** `chatgpt_base_url` nor `openai_base_url` in ChatGPT mode (D0 / D5 step 5) **and** `srt` cannot wrap it (D5). Then model traffic leaves the container with no run-scoped JWT, no run-status gating, no path allowlist, no size cap, and no log — every property the gateway exists to provide, absent at once.
- **D-fail-3 — the credential would be durable inside the run.** D2 shows the CLI refuses (or silently API-key-falls-back on) a bundle without `tokens.refresh_token`, **and** D3 confirms `$CODEX_HOME/auth.json` is readable from the run's own workspace. openfloor publishes what a run produces to a GitHub branch, so the run's workspace is not a private boundary and must not be treated as one. **The requirement is a lifetime bound, not a hiding place:** a credential placed in a run must expire on the order of the run itself (D1's TTL). A durable one does not meet that bar.
- **D-fail-4 — rotation unimplementable.** D4 shows the rotated bundle cannot be reliably read back and re-encrypted (wrong path, race, ownership, or a shape the parser rejects) while the design requires it. The stored copy then goes stale silently and every future run of that member breaks with no signal.
- **D-fail-5 — silent payer switch.** At any point, a misconfigured or expired bundle causes the CLI to fall back to API-key mode rather than failing. That violates the standing invariant directly and cannot be mitigated downstream, because openfloor never sees the decision.

**Run D0 step 4 first.** Everything else is downstream of whether the credential has to be in the container at all.

## The two hazards §5 names, pressure-tested

### Hazard 1 — rotation invalidates the member's own laptop login

§5 states the mitigation ("write it back") before establishing the mechanism. Three things it does not say:

1. **The invalidation is not a bug and writing back does not fix it.** A rotating refresh token held in two places means whichever holder rotates last wins; the other copy is dead. openfloor writing back keeps *openfloor's* copy fresh and does nothing for the member's laptop — their local `codex` login will need redoing. **That sentence must be in the Settings connect copy before the member pastes**, not buried in a decision log. Today's copy (`ProviderCredentials.tsx:164-170`) says rate limits are theirs and disconnecting is immediate; it does not say connecting will eventually break their own CLI.
2. **The spike itself burns a login.** D4 deliberately forces a rotation. Use a scratch account or accept re-logging-in locally. Say so in the runbook so it is not discovered mid-spike.
3. **The refresh-token-free design removes the racing half by construction**, which is the strongest argument for gating on D2 rather than treating it as an optimization. A container with no refresh token cannot rotate anything, so the only rotation is openfloor's own server-side one under D6.

**Residual after all mitigation:** the member's laptop login will break at some point after connecting. That is inherent to a rotating refresh token existing in two places. It is a **product** decision, not an engineering one, and it should be made explicitly *before* Gate D is run — if the answer is "we won't ask members to accept that", the spike need not run at all.

### Hazard 2 — credential lifetime inside a run

§5's framing is right and its mitigation is incomplete. Stated as acceptance criteria:

- **The run's workspace is not a private boundary.** `workspace-write` bounds writes, not reads (D3), and the agent's shell runs as the CLI's own user, so there is no user-separation layer to add. Publishing what a run produces is the product's core feature, not a gap to close.
- **So the control is lifetime, not concealment.** `CODEX_HOME` under `/tmp/openfloor/` keeps the file out of the changed-path set (prepare wipes it at `:154`) and is worth doing, but it is hygiene rather than the mitigation.
- The only real reductions are: **(a)** the credential is never in the container — D0's outcome; **(b)** the credential expires on the order of a single run — the refresh-token-free bundle, bounded by D1's TTL; **(c)** neither, and Gate D fails on D-fail-3.
- `networkAccessEnabled: false` (`scripts/codex-runner.mjs:154`) is already set and stays set. It is not part of this argument either way.

The requirement is uniform across run kinds. Reply runs get `sandboxMode: "read-only"` (`codex-runner.mjs:152`), which bounds writes further but does not change the lifetime requirement. **Do not carve an exception for any run kind.**

## §5 — the shipped design, if Gate D passes

Two shapes, selected by D0's answer.

**Shape A — gateway stays in the path (preferred; ship this if D0 passes).**
- Widen `credentialKindsForProvider` (`lib/provider-credentials.ts:34`) to allow `oauth` for `openai`. Settings' dormant bundle form and the dialog's Billing field light up unchanged.
- `app/runtime/openai/[...path]/route.ts` — replace the `:35-45` refusal with kind-aware header construction, mirroring `AnthropicCompatGatewayConfig.buildAuthHeaders(secret, kind)`. If `lib/responses-gateway.ts` has already been extracted (ENG-118 route C), land it there instead; do the extraction once, whichever ticket gets there first.
- Add the observed `chatgpt.com/backend-api/codex` path to the allowlist, grown from D0 step 2's log.
- **Header hygiene is not optional.** A pasted `auth.json` is pretty-printed; its interior newlines would crash `Headers.set` into an opaque 500 (`AGENTS.md:1745` records this being caught in adversarial review). The gateway extracts `tokens.access_token` from the stored JSON and sends **only that** — never the bundle, never `refresh_token`.
- `scripts/codex-runner.mjs` — **unchanged.** It keeps sending its run-scoped JWT as `CODEX_API_KEY` via `apiKey`, plus `chatgpt_base_url` via `config` pointed at `/runtime/openai`. Supply that value from **workflow env**, not hardcoded in the runner: env means **no image bump**.
- Server-side refresh under D6's conditional update, before each run's start step.
- **Hazard 2 does not apply to this shape.** Say so explicitly in the decision log — it is the whole reason this shape is preferred.

**Shape B — credential written into the run (only if D0 fails and D2 and D5 both hold).**
- `scripts/codex-runner.mjs` gains a ChatGPT branch: omit `apiKey` (Correction 2 — one conditional), set `CODEX_HOME` under the per-run scratch tree, and pass `cli_auth_credentials_store: "file"` (and `forced_login_method`, if D0 step 3 showed it pins the mode) through the SDK's `config` override, next to the existing `mcp_servers` at `:148`. **That is a `COPY`'d script change ⇒ bump `RUN_SANDBOX_IMAGE_VERSION` from `v4` to `v5` in the same commit.**
- The workflow writes a **minimal derived bundle**: access token, `account_id`, `last_refresh` = now, **`refresh_token` omitted**. Refresh happens server-side.
- `srt` wrap per D5, with `chatgpt.com` and `auth.openai.com` allowed. Document whichever posture ships in the decision log the way the Gemini entry does (`AGENTS.md:1693-1697`) — **and if the posture is weaker than Claude's or Gemini's, say that in the entry** rather than letting the reader infer parity.

**Both shapes:**
- Settings copy gains the laptop-invalidation sentence (hazard 1, item 1).
- `validateProviderOauthSecret` (`lib/provider-validation.ts:41`) stays returning `null` for `openai` unless the spike finds a free probe — `validated_at = null`, "Connected — not yet verified", **never a faked timestamp**.
- `AGENTS.md:184` (implemented list), the withholding entry at ~`:1747` (**mark superseded, do not delete** — `AGENTS.md:19`), and `docs/agent-backend-gaps.md:26` all change.

## Tests

All in existing files — `package.json:15` enumerates `test:worker` by name, so a new worker test file silently never runs.

- **`tests/worker/credentials.test.ts:833-852`** — this is the test that **inverts** when this ships. Rewrite it: a resolved openai oauth bundle produces the correct upstream call with **only** the access token in the header, the bundle's newlines never reach a header value, and `refresh_token` appears nowhere in the outbound request. Keep a sibling case proving a **malformed** stored bundle still refuses rather than sending garbage.
- Same file: two same-owner agents, one `api_key` one `oauth`, each run resolving its own credential (mirror the `:697` pattern, currently anthropic-only). And — **the most important assertion in this ticket** — a `credential_kind = 'oauth'` agent whose owner has disconnected the bundle refuses with the `missing_selected_kind` message **while a server `OPENAI_API_KEY` is present**, so the assertion is that it refused rather than silently billing openfloor.
- **`tests/unit/provider-credentials.test.ts`** — `credentialKindsForProvider("openai")` now returns both kinds; `credentialKindLabel("openai","oauth") === "ChatGPT subscription"` (already implemented at `lib/provider-credentials.ts:42`, currently unreachable through the UI path). Keep every `anthropic` assertion passing unchanged.
- **`tests/unit/validation.test.ts`** — `parseAgentInput` accepts `credentialKind: "oauth"` under `provider: "openai"` (today a 400) and still rejects it under `kimi`.
- **`tests/render/credentials.test.ts`** — the openai oauth row renders and connects through the bundle textarea; a `{ authJson }` PUT succeeds where it currently 400s.
- **`tests/worker/routing.test.ts`** — only if Shape B's per-owner lock ships: a second concurrent ChatGPT-subscription item is **skipped** and the rest of the queue keeps dispatching. Extend the `:308` mixed-provider test rather than adding a file.

`npm test` green on every commit.

## If Gate D fails — docs and comments only

No code path changes, no test inversions, no widening.

1. **`AGENTS.md` decision-log entry** — *"2026-08-26 — ChatGPT-subscription Codex stays unbuilt: Spike D fails on \<the specific gate\>"*. **Decision:** `credentialKindsForProvider("openai")` stays `["api_key"]`; the gateway's oauth refusal stays; the parse shape and dormant form stay. **Rationale:** every D-step's measured answer — TTL, base-URL honor for **both** `chatgpt_base_url` and `openai_base_url`, refresh-token-free behavior, read access, write-back mechanics, `srt` nesting — with Correction 1's binary evidence cited so the next attempt starts from data instead of the doc. **Consequences:** the exact condition that reopens it (most likely "a Codex pin whose CLI honors `chatgpt_base_url` in ChatGPT mode", or "the CLI ceasing to validate the access token locally"), plus the standing note that hazard 1's laptop invalidation is a product decision to be made before the spike is worth re-running.
2. **`docs/agent-backend-gaps.md:26`** — the "Credential kinds — deliberately deferred pieces" paragraph currently says §5 is "gated on Spike D, which has not run". Change to: Spike D ran on \<date\> and failed on \<gate\>, with the reopening condition.
3. **`docs/glm-grok-subscription-provider-prompt.md:81-88`** — append an `> Outcome` block under Spike D, matching the format of Spikes A/B/C, **and correct step 2 in place** to name `chatgpt_base_url` (Correction 1). Land that correction even in the failure commit — it is the single thing most likely to change the answer next time.
4. **`lib/provider-credentials.ts:29-33`** — extend the withholding comment with the spike date and outcome, so the next reader knows it was **tested**, not merely deferred.

`npm test` green by construction. Nothing deploys.

## Invariants

- **No request-body rewriting in any gateway.** Headers may be substituted; bodies may not be edited. This constrains §5's design to header substitution.
- **No subscription credential is ever a server fallback.** Server bindings are plain strings and are `api_key` by construction.
- **Never fall back from a present-but-broken owner credential to the server key** — including an unusable oauth credential and an agent whose named kind is not connected.
- **Per-item skip, never a session-wide hold.**
- **Bump `RUN_SANDBOX_IMAGE_VERSION`** in any commit touching `Dockerfile.sandbox` or a `COPY`'d script. Shape B does; Shape A should not.
- **Never rename `agent_runs.codex_thread_id`** (exposed as `providerThreadId`); the `codex_log` artifact kind and `codex.log` R2 key stay shared across providers.
- **No metering, no quota display.** Runners capture `usage` into `result.json` and `parseCodexResult` discards it.
- 404 concealment on every gateway rejection; every rejected path logged with its provider prefix so allowlists grow from evidence.
- **AGENTS.md maintenance in the same commit** (`AGENTS.md:7`); superseded text marked superseded (`AGENTS.md:19`).

## Sequencing

1. **Spike D** — D0 first, then D1–D6. Report before anything lands. Budget for burning a ChatGPT login.
2. **Gate D fails → the "do not ship" commit.** ENG-117 closes as a documented refusal. This is the expected path.
3. Gate D passes, **Shape B only:** commit the image bump (`Dockerfile.sandbox`, `RUN_SANDBOX_IMAGE_VERSION` `v4 → v5`, the runner's ChatGPT branch) with the existing `openai` API-key path regression-tested first.
4. Commit — widen `credentialKindsForProvider`, gateway kind-awareness, server-side refresh with D6's conditional update, Settings copy including the laptop-invalidation line, the inverted `:833` test and the new resolution tests, `AGENTS.md` supersession.
5. Deploy, then acceptance. **There is no flag for §5** — it changes an existing provider's credential handling, so the withholding line *is* its gate and step 4 is the flip.

## Acceptance, if it ships

1. Connect a scratch ChatGPT bundle **alongside** an OpenAI API key. Confirm two independently connectable Settings rows and that connecting one did not overwrite the other (`ON CONFLICT(user_id, provider, kind)`).
2. Create two agents owned by the same member, one `credential_kind: "api_key"`, one `"oauth"`. Run both. Confirm from the gateway logs (Shape A) or the container's resolved config (Shape B) that **each used the credential its agent named**.
3. Disconnect the subscription. Confirm the subscription-bound agent refuses with the `missing_selected_kind` message while the API-key agent keeps running — **with `OPENAI_API_KEY` set**, so the assertion is that it refused rather than silently billing openfloor.
4. Confirm the stored bundle was rewritten after a run that triggered a rotation, and that the rewritten value still decrypts and still parses.
5. Confirm two **different** members with separate ChatGPT credentials run concurrently without either bundle breaking.
6. Confirm the **same** member's two concurrent runs either both complete (refresh-token-free design) or the second is per-item **skipped** rather than started (fallback design) — whichever D2 selected. Confirm the rest of the session's queue kept dispatching either way.
7. Review the run's egress: Shape A — only `/runtime/openai/*` in the Worker log, zero rejected-path warnings, and every rejected path either allowlisted with its log line cited or confirmed safe to refuse. Shape B — the `srt` allowlist held and no host outside `chatgpt.com` / `auth.openai.com` was reached.

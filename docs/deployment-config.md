# Deployment Configuration: Bindings, Secrets, and Rollout Gates

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size threshold. This is the authoritative source for every binding, secret, and rollout-gate flag — keep it factually correct the same way `CLAUDE.md` itself must stay correct (update it in the same change as any behavior it describes).

---

### Required bindings

The top-level `wrangler.jsonc` target is production; the named
`env.development` target is the permanent `release`-branch deployment. Both
provide `DB`, `SESSION_PRESENCE`, `ASSETS`, `IMAGES`,
`REPOSITORY_PREFLIGHT`, `AGENT_RUN_WORKFLOW`, `SANDBOX`, `PREFLIGHT_LOGS`,
and `USER_AVATARS`.

Stateful authority is isolated:

| Binding | Production | Development |
| --- | --- | --- |
| Worker/domain | `openfloor` / `app.opnflr.com` | `openfloor-development` / `dev.app.opnflr.com` |
| `DB` | `openfloor-production` | `openfloor-development` |
| `PREFLIGHT_LOGS` | `openfloor-preflight-logs` | `openfloor-development-preflight-logs` |
| `USER_AVATARS` | `openfloor-user-avatars` | `openfloor-development-user-avatars` |
| `REPOSITORY_PREFLIGHT` | `openfloor-repository-preflight` | `openfloor-development-repository-preflight` |
| `AGENT_RUN_WORKFLOW` | `openfloor-agent-run` | `openfloor-development-agent-run` |

Each named Worker owns distinct Durable Object namespaces and container state.
Runtime secrets, Access audiences, GitHub Apps, webhook signing, encryption keys,
and any Stripe/provider credentials are also environment-specific. Never bind a
development resource to production state. See `docs/release-process.md` for the
one-time external setup and ongoing promotion/hotfix workflow.

Cloudflare Containers requires a Workers Paid account. `PREFLIGHT_ENABLED` is the production rollout gate: production is enabled only after the container image, `SANDBOX`, and `REPOSITORY_PREFLIGHT` bindings deploy successfully. While disabled, the UI omits **Verify runner** and the start endpoint returns `503`; repository connection and candidate reconciliation remain available. Tests explicitly enable the deterministic test adapter.

`EARLY_ACCESS_GATE_ENABLED` controls enforcement only. The disabled-mode production rollout, D1 waitlist writes, signed Sheet delivery, secrets, and the combined WAF rule have been accepted; production is now set to `true`, gating protected pages, APIs, desktop bootstrap, invitations/onboarding, and presence. Rollback is `false`; grants, revocations, and waitlist rows remain intact. See `docs/early-access.md`.

`AGENT_RUN_ENABLED` independently gates all agent execution and is **true in production for admitted beta testers** after Sandbox image `v9` deployed successfully. Image `v9` runs token-bearing provider CLIs as `openfloor-provider`, fixed-policy srt setup as credential-free `openfloor-broker`, and model-selected commands as `openfloor-workspace`. The root-owned launcher clears credentials; its guarded bubblewrap seam refuses workspace callers and caller-selected identity, capability, or user-namespace options and creates the fixed filesystem/network/PID sandbox. A root-owned non-setuid handoff then selects the workspace uid/gid and retains only the setup capability required by the validated pinned `apply-seccomp` command; `apply-seccomp` clears it and sets `no_new_privs` before model-selected code. CI builds the real image and adversarially checks inherited environment, `/proc/*/environ`, memory/fds, command lines, process listings, provider-home access, direct bubblewrap refusal, zero final capabilities, and the command's `no_new_privs` state. OpenAI, Claude, Kimi, and Gemini are exposed under the early-access admission, membership, ownership, quota, and provider-credential controls. GLM, Qwen, and DeepSeek remain off behind their independent flags. Rollback is a reviewed config change to `false`, which hides **Run** and makes direct starts return `503` without deleting agents or run history.

Development starts with `AGENT_RUN_ENABLED=false`,
`STRIPE_CHECKOUT_ENABLED=false`, and `EARLY_ACCESS_GATE_ENABLED=false`. Access
still authenticates the development hostname through `/auth/complete` and
`/api/*`; its policy must allow only developers/testers because the separate D1
admission gate is off. Enabling execution or test-mode
billing there is a separate reviewed rollout after isolated credentials,
webhooks, and acceptance exist; development must never use production Stripe
objects or the production waitlist Sheet destination.

Defense in depth remains mandatory while the gate is open: Codex receives only an explicit safe SDK environment and sends shell commands through the workspace launcher; Gemini/Qwen apply the same safe allowlist and launcher to every supported `node:child_process` API and overload. Claude routes sandboxed Bash through the workspace launcher. The exact built-in MCP command alone receives its explicit context/conflict variables. Any isolation-test regression requires keeping or returning the global gate to `false`.

`STRIPE_CHECKOUT_ENABLED` gates new Checkout and plan-change flows. Production is
true after its live-mode rollout; development starts false and may enable only
after separate Stripe test-mode prices, Portal configuration, secrets, webhook,
migrations, and acceptance from `docs/stripe-billing.md` are complete. Existing
entitlement reads and signed webhook reconciliation do not depend on this gate.

`CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, `GEMINI_RUN_ENABLED`, `GLM_RUN_ENABLED`, `QWEN_RUN_ENABLED`, and `DEEPSEEK_RUN_ENABLED` independently gate their providers' runs (one flag per provider id; `disabledRunProviders()` in `lib/provider-rollout.ts` is the single reader, re-exported by `lib/agent-run-start.ts` for compatibility). For each: keep it `false` until the deploy containing its code (and any bumped image) is live, its gateway route is reachable, and a credential resolves (owner-connected or server) — then run the per-provider acceptance runbook (staging session, full run arc, gateway rejected-path log review) before flipping. While a flag is false, a *manual* start of that provider's item refuses as `disabled` at the `startQueueItemRun` seam, agent *creation* and generated-agent default selection for it refuse with `503`, and *auto-dispatch* skips its items per-item (`RoutingDeps.disabledProviders`) so they never hold the rest of a mixed queue; other providers' runs are unaffected either way. Rollback = flip back: existing agents persist and generated-provider resolution ignores disabled choices until an enabled credential/default is available.

Durable Object migration `v1` registers `SessionPresence`; `v2` registers `Sandbox`. Keep migration syntax compatible with the pinned Wrangler version.

The Sandbox image is `cloudflare/sandbox:0.12.7` pinned to digest `sha256:6d741713aef266e8ae0831a5709c6f2d7b77b4952ac79b549f4f4e380af86fbe`; `@cloudflare/sandbox` stays pinned to `0.12.7`, and the pool key is `RUN_SANDBOX_IMAGE_VERSION = "v9"`. The image installs `undici@7.29.0`, the provider, broker, and workspace runtime identities, and the hardened identity launcher compiled from `scripts/runtime-identity.c`. Any image-content change must bump the pool version. A 10-minute cron and the daily retention cron both sweep durable R2 cleanup intents; the cleaner needs both R2 bindings above.

### Required secrets

- `INVITE_SIGNING_SECRET`
- `EARLY_ACCESS_PASSWORD` (shared beta passcode; rotation affects future admissions, not existing grants)
- `WAITLIST_SHEET_WEBHOOK_URL` (Apps Script `/exec` deployment URL)
- `WAITLIST_SHEET_WEBHOOK_SECRET` (same random HMAC key stored in Apps Script Project Properties)
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

Set a production secret by its variable name, then enter the value when prompted:

```bash
npx wrangler secret put INVITE_SIGNING_SECRET
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

Set a development secret with `--env development`; use fresh values rather than
copying production signing, encryption, GitHub App, or webhook secrets:

```bash
npx wrangler secret put INVITE_SIGNING_SECRET --env development
npx wrangler secret put CF_ACCESS_AUD --env development
```

Do not pass the secret value as the `wrangler secret put` name. Never commit `.dev.vars`, Access credentials, signing secrets, tokens, or generated invite URLs.

### CI and deployment gate

`.github/workflows/deploy.yml` runs on every pull request and on pushes to
`release` and `main`. Every event installs the exact pinned npm CLI, runs
`npm audit --omit=dev`, installs the lockfile-selected Playwright Chromium build
and runner dependencies, and runs the complete `npm test`-equivalent pipeline.
After the render build, CI verifies production, builds and verifies development,
then lets E2E replace `dist/`. Unit fixtures prove that the verifier rejects a
wrong D1 ID, cross-environment R2 bindings, rollout drift, and test artifacts.

Pull requests stop after validation. CI accepts ordinary PRs only when they
target `release`; the only `main`-targeted exceptions are `release` promotions
and `hotfix/*` branches. A push to `release` migrates only the
development D1 database, rebuilds, verifies the `development` artifact, and
deploys through the GitHub `development` environment. A push to `main` performs
the equivalent production sequence through the `production` environment. Both
deploys record their Git SHA in the Cloudflare version message, stay serialized
per branch, and never cancel in flight. GitHub actions are commit-SHA pinned, checkout
uses `persist-credentials: false`, and the workflow token has read-only repository
access. Cloudflare credentials are referenced only by migration and deployment
steps.

The manual emergency order is the same trust boundary: run the dependency audit
and complete tests before applying the target's remote migration, then build,
run `npm run verify:deploy-artifact -- development|production`, and deploy the
verified target. Merging `release` to `main` or merging an explicit hotfix is
production authorization; a pull-request run never mutates either environment.

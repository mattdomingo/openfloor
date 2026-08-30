# Deployment Configuration: Bindings, Secrets, and Rollout Gates

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size threshold. This is the authoritative source for every binding, secret, and rollout-gate flag — keep it factually correct the same way `CLAUDE.md` itself must stay correct (update it in the same change as any behavior it describes).

---

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
- `USER_AVATARS`: private R2 bucket `openfloor-user-avatars`.

The phased GitHub rollout currently uses the existing production Worker and D1 database. GitHub App setup and deployment are documented in `docs/github-production.md`. Until the user establishes staging, install the App only on the disposable acceptance repository and complete each phase's browser acceptance before expanding repository access.

Cloudflare Containers requires a Workers Paid account. `PREFLIGHT_ENABLED` is the production rollout gate: production is enabled only after the container image, `SANDBOX`, and `REPOSITORY_PREFLIGHT` bindings deploy successfully. While disabled, the UI omits **Verify runner** and the start endpoint returns `503`; repository connection and candidate reconciliation remain available. Tests explicitly enable the deterministic test adapter.

`AGENT_RUN_ENABLED` independently gates all agent execution. It is currently **false in production as a security hold**: provider CLIs and repository-controlled processes share the `openfloor-agent` Linux uid, and Linux exposes each process's initial environment through same-uid `/proc` reads even after JavaScript deletes those variables. Child-process environment filtering therefore does not prove gateway-token isolation. Keep this global gate false until the container uses a separate uid/process boundary (or equivalent kernel isolation) and adversarial tests prove environment, command-line, child-process, and `/proc` isolation. While false the UI omits **Run**, direct starts return `503`, and provider-specific gates cannot override it. Tests enable only deterministic test adapters.

Defense in depth still must remain complete while the gate is closed: Codex receives only an explicit safe SDK environment and gives repository commands an explicit `PATH`/`HOME`-class environment with no inheritance; Gemini/Qwen apply the same safe allowlist to every supported `node:child_process` API and overload. The exact built-in MCP command alone receives its explicit context/conflict variables. These controls reduce accidental child inheritance but do not authorize enabling runs while same-uid `/proc` remains.

`STRIPE_CHECKOUT_ENABLED` gates new Checkout and plan-change flows. Keep it false until both exact monthly prices, the restricted Portal configuration, all Stripe secrets, D1 migrations, public webhook delivery, and test-mode acceptance in `docs/stripe-billing.md` are complete. Existing entitlement reads and signed webhook reconciliation do not depend on this gate.

`CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, `GEMINI_RUN_ENABLED`, `GLM_RUN_ENABLED`, `QWEN_RUN_ENABLED`, and `DEEPSEEK_RUN_ENABLED` independently gate their providers' runs (one flag per provider id; `disabledRunProviders()` in `lib/provider-rollout.ts` is the single reader, re-exported by `lib/agent-run-start.ts` for compatibility). For each: keep it `false` until the deploy containing its code (and any bumped image) is live, its gateway route is reachable, and a credential resolves (owner-connected or server) — then run the per-provider acceptance runbook (staging session, full run arc, gateway rejected-path log review) before flipping. While a flag is false, a *manual* start of that provider's item refuses as `disabled` at the `startQueueItemRun` seam, agent *creation* and generated-agent default selection for it refuse with `503`, and *auto-dispatch* skips its items per-item (`RoutingDeps.disabledProviders`) so they never hold the rest of a mixed queue; other providers' runs are unaffected either way. Rollback = flip back: existing agents persist and generated-provider resolution ignores disabled choices until an enabled credential/default is available.

Durable Object migration `v1` registers `SessionPresence`; `v2` registers `Sandbox`. Keep migration syntax compatible with the pinned Wrangler version.

The Sandbox image is `cloudflare/sandbox:0.12.7` pinned to digest `sha256:6d741713aef266e8ae0831a5709c6f2d7b77b4952ac79b549f4f4e380af86fbe`; `@cloudflare/sandbox` stays pinned to `0.12.7`, and the pool key is `RUN_SANDBOX_IMAGE_VERSION = "v8"`. The image installs `undici@7.29.0`. Any image-content change must bump the pool version. A 10-minute cron and the daily retention cron both sweep durable R2 cleanup intents; the cleaner needs both R2 bindings above.

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

### CI and deployment gate

`.github/workflows/deploy.yml` runs on every pull request and push to `main`. Both event types install with the exact pinned npm CLI, run `npm audit --omit=dev`, and run the complete `npm test` pipeline. Only a push to `main` may continue to the remote D1 migration, production build, and Worker deploy; those steps remain serialized and are never cancelled. Superseded pull-request checks may cancel. GitHub actions are commit-SHA pinned, checkout uses `persist-credentials: false`, and the workflow's default token has only read access to repository contents. Cloudflare credentials are present only on the remote migration and deploy steps.

The manual emergency order is the same trust boundary: run `npm audit --omit=dev` and `npm test` before applying a remote migration. Merging to `main` remains production authorization; a pull-request run never mutates production.

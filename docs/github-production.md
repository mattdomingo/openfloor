# Production GitHub App rollout

openfloor connects the production application to a GitHub App, keeps one real candidate branch, and runs Codex plus required checks in Cloudflare Sandbox. Every passing result is retained on a separate verified run branch, then serialized into the candidate and its single draft pull request. The owner can mark that PR ready and request an exact-head squash merge after GitHub reports clean mergeability and passing checks. During acceptance, install the App only on a real disposable repository.

## Production host and Cloudflare Access

The application is served at `https://app.opnflr.com`. Cloudflare Access protects it as an explicit allowlist — split across two self-hosted applications sharing one policy, since Access caps a single application at five destinations and there are six protected paths:

- App 1 ("OpenFloor authenticated users"): `app.opnflr.com/home`, `app.opnflr.com/settings`, `app.opnflr.com/onboarding`, `app.opnflr.com/session/*`, `app.opnflr.com/join/*`
- App 2 (same policy, attached via "Add existing policy"): `app.opnflr.com/api/*`

This list is per-path, dashboard-configured state (see `docs/cloudflare-access-branding.md` and AGENTS.md's "Authentication and identity") — every new protected page needs its path added to whichever Access application has room in Zero Trust, or visitors get bounced back to sign-in on that page even while authenticated everywhere else.

App 2's only destination is a wildcard path, so its App Launcher tile must stay hidden (**Experience settings → "Show application in App Launcher"** off) — otherwise it's the literal, unroutable `app.opnflr.com/api/*`, and a user re-entering through the team domain after signing out has a real chance of picking it (2026-08-24 decision log).

Do not put `app.opnflr.com/webhooks/github` or `app.opnflr.com/webhooks/stripe` behind Access. Both are public only so GitHub and Stripe can reach them; the Worker rejects payloads without the configured HMAC signature. Neither is `app.opnflr.com/runtime/*`, which run containers fetch with bearer tokens — an Access rule over those paths breaks every agent run. None of the three need a bypass rule: a path with no matching Access-application destination is simply never touched by Access. (Do not try to express "public" as a bypass destination scoped to `/` — Cloudflare has no root-only Path syntax; a blank or `*` Path means the hostname plus everything beneath it, so a "bypass `/`" destination bypasses the whole domain.)

Verify all three stay reachable after any Zero Trust edit:

```bash
for p in /webhooks/github /webhooks/stripe /runtime/run/source; do
  printf '%-32s ' "$p"; curl -sI "https://app.opnflr.com$p" | head -1
done
```

A `302` to `*.cloudflareaccess.com` on any of them is a misconfiguration; the Worker itself returns `4xx`, never `302`.

## Create the GitHub App

Create a private GitHub App in GitHub settings with:

- GitHub App name: a unique name, such as `openfloor`.
- Homepage URL: `https://app.opnflr.com`.
- Setup URL: `https://app.opnflr.com/api/github/callback`.
- Redirect on update: enabled.
- Webhook URL: `https://app.opnflr.com/webhooks/github`.
- Webhook secret: a new random value used only by this App.
- Request user authorization during installation: disabled.

Repository permissions:

- Metadata: read-only.
- Contents: read and write.
- Pull requests: read and write.
- Checks: read-only.
- Commit statuses: read-only.
- Administration: no access.
- Workflows: no access.

Subscribe to `installation`, `installation_repositories`, `repository`, `push`, `pull_request`, `check_run`, `check_suite`, and `status` events. Phase 2 authenticates and deduplicates deliveries, updates access and repository identity, and invalidates repository/review state for pushes, pull requests, checks, and statuses.

Generate and download a private key. Create a disposable repository with at least one commit on its default branch, then install the App on only that repository during phased acceptance.

## Configure secrets

The existing production Worker already has the Access and invite secrets. Add the five GitHub App secrets:

```bash
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_SLUG
npx wrangler secret put GITHUB_STATE_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < /absolute/path/to/downloaded-private-key.pem
```

Pipe the downloaded PEM file into Wrangler as shown. Do not type its path as the secret value and do not paste only the first PEM line. openfloor accepts both GitHub's downloaded `RSA PRIVATE KEY` (PKCS#1) format and PKCS#8 `PRIVATE KEY` format. Generate an independent random state secret; do not reuse the webhook secret.

Create and store an independent runtime-gateway secret:

```bash
openssl rand -hex 32 | npx wrangler secret put RUNTIME_GATEWAY_SECRET
```

The gateway token can fetch only the exact candidate archive for one preflight. It is not a GitHub credential.

Create and store the credential-encryption secret for user-connected provider API keys:

```bash
openssl rand -hex 32 | npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

Rotating this value invalidates every stored user credential — users must reconnect their keys in `/settings`.

Optional server-side fallback keys, one per provider; without one, that provider's runs require the agent owner's connected key. Keep each provider's rollout flag (`CLAUDE_RUN_ENABLED`, `KIMI_RUN_ENABLED`, `GEMINI_RUN_ENABLED`) set to `false` until its code (and any bumped sandbox image) deploys and a credential resolves — while false, that provider's runs refuse as disabled and other providers are unaffected.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put MOONSHOT_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ZAI_API_KEY
```

Add an OpenAI project API key for server-side Codex execution:

```bash
npx wrangler secret put OPENAI_API_KEY
```

Enter the key at Wrangler's prompt. Do not place it in a repository, check command, queue prompt, or command-line argument. openfloor injects it only at the trusted Responses gateway; the Sandbox receives a short-lived run token instead of the project key.

## Configure Workflow, Sandbox, and R2

`wrangler.jsonc` defines the `REPOSITORY_PREFLIGHT` and `AGENT_RUN_WORKFLOW` Workflows, `SANDBOX` container/Durable Object, and private `PREFLIGHT_LOGS` R2 binding. Create the bucket once:

```bash
npx wrangler r2 bucket create openfloor-preflight-logs
```

The package and image are both pinned to Sandbox `0.12.7`. Keep Docker running for local `wrangler dev` and deployments that build the container image.

Cloudflare Containers requires the Workers Paid plan. Keep `PREFLIGHT_ENABLED` set to `false` until the account has Containers access and the image, Sandbox binding, and Workflow deploy successfully. The false setting hides **Verify runner** and makes direct start requests return `503`, while leaving repository connection and candidate reconciliation available.

For loopback development, put the same GitHub values in `.dev.vars`. Represent private-key line breaks as `\\n` inside the value.

## Migrate and deploy

```bash
npm test
npx wrangler d1 migrations apply DB --remote
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

After the container-enabled deployment succeeds, set `PREFLIGHT_ENABLED` to `true`, rebuild, and deploy again. Keep `AGENT_RUN_ENABLED=false` until the updated Codex image and `AGENT_RUN_WORKFLOW` deploy and `OPENAI_API_KEY` appears in `npx wrangler secret list`. Then set it to `true`, rebuild, and deploy again. Do not enable either flag before its runtime prerequisites are live.

Each passing result is exported as an incremental Git bundle, validated in a clean publisher Sandbox, and pushed as a single commit without force to `openfloor/<session-short>/run/<run-short>`. A D1 candidate lease serializes GitHub merges into the active candidate branch. The first integration opens one draft pull request into the configured base; later integrations update the same PR. Conflicts leave the candidate unchanged and expose owner-only **Retry against latest candidate**, which creates a new attempt and branch.

Phase 7 reconciles the PR head/base, bounded GitHub diff, checks/statuses, draft state, and mergeability. **Ready for review** uses GitHub's draft-review mutation. **Squash merge** is enabled only for the owner after GitHub reports an open, non-draft, clean, mergeable PR with all observed checks passing; the request includes the exact candidate SHA and GitHub protection failures are surfaced without claiming success. After GitHub confirms the squash commit, openfloor marks the candidate merged and deletes only matching server-generated run/candidate refs with Git `--force-with-lease`. Changed refs are preserved and reported as partial cleanup. The next run creates a fresh candidate from the latest base. openfloor still exposes no caller-selected ref, generic branch CRUD, force update, protection change, administration operation, or alternate merge method.

Known follow-up: production discard remains unresolved after the Phase 5 transport-authentication correction. Do not weaken its expected-SHA lease; verify Phase 6 independently and return to discard in its separate ticket.

Required check commands are optional while connecting a repository. A later runner or integration action must refuse to execute until the owner configures at least one command.

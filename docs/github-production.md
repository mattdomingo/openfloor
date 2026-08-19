# Production GitHub App rollout

Phase 4 connects the production OpenFloor application to a GitHub App, keeps one real candidate branch, and runs Codex plus required checks in Cloudflare Sandbox. Passing changes are reviewed locally in OpenFloor and are not pushed to GitHub until Phase 5. During phased acceptance, install the App only on a real disposable repository.

## Production host and Cloudflare Access

The application is served at `https://opnflr.com/app`. The existing Cloudflare Access application protects:

- `opnflr.com/app/home`
- `opnflr.com/app/session/*`
- `opnflr.com/app/join/*`
- `opnflr.com/app/api/*`

Do not put `opnflr.com/app/webhooks/github` behind Access. It is public only so GitHub can reach it; the Worker rejects payloads without the configured HMAC signature.

## Create the GitHub App

Create a private GitHub App in GitHub settings with:

- GitHub App name: a unique name, such as `OpenFloor`.
- Homepage URL: `https://opnflr.com/app`.
- Setup URL: `https://opnflr.com/app/api/github/callback`.
- Redirect on update: enabled.
- Webhook URL: `https://opnflr.com/app/webhooks/github`.
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

Pipe the downloaded PEM file into Wrangler as shown. Do not type its path as the secret value and do not paste only the first PEM line. OpenFloor accepts both GitHub's downloaded `RSA PRIVATE KEY` (PKCS#1) format and PKCS#8 `PRIVATE KEY` format. Generate an independent random state secret; do not reuse the webhook secret.

Create and store an independent runtime-gateway secret:

```bash
openssl rand -hex 32 | npx wrangler secret put RUNTIME_GATEWAY_SECRET
```

The gateway token can fetch only the exact candidate archive for one preflight. It is not a GitHub credential.

Add an OpenAI project API key for server-side Codex execution:

```bash
npx wrangler secret put OPENAI_API_KEY
```

Enter the key at Wrangler's prompt. Do not place it in a repository, check command, queue prompt, or command-line argument. OpenFloor injects it only at the trusted Responses gateway; the Sandbox receives a short-lived run token instead of the project key.

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

Phase 4 adds owner-only **Run** and **Cancel** controls for assigned queue items. Codex uses `gpt-5.6-terra` with workspace-write permission against the exact candidate SHA, then OpenFloor runs the configured checks and displays real changed files/diffs. Passing changes remain inside the isolated runtime and leave the queue item blocked for Phase 5 publication. Failed and cancelled items remain retryable. OpenFloor still exposes no caller-selected ref, force push, base write, run-branch publication, pull request, or merge operation.

Required check commands are optional while connecting a repository. A later runner or integration action must refuse to execute until the owner configures at least one command.

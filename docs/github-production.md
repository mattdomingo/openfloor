# Production GitHub App rollout

Phase 1 connects the existing production OpenFloor application to a GitHub App. During phased acceptance, install the App only on a real disposable repository. The repository is not mock data: it is an intentionally throwaway GitHub repository where later phases can safely create and merge real code changes.

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

Subscribe to `installation`, `installation_repositories`, `repository`, `push`, `pull_request`, `check_run`, `check_suite`, and `status` events. Phase 1 authenticates delivery and acknowledges events; durable reconciliation begins in Phase 2.

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

For loopback development, put the same GitHub values in `.dev.vars`. Represent private-key line breaks as `\\n` inside the value.

## Migrate and deploy

```bash
npm test
npx wrangler d1 migrations apply DB --remote
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

The repository connection is read-only at the product-workflow level in Phase 1. Although the GitHub App has future branch permissions, OpenFloor exposes no ref creation, update, deletion, commit, pull-request, or merge operation until its accepted later phase.

Required check commands are optional while connecting a repository. A later runner or integration action must refuse to execute until the owner configures at least one command.

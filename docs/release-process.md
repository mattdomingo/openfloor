# Release branches and deployments

openfloor uses one permanent integration branch and two isolated Cloudflare
deployments:

| Git branch | Purpose | Cloudflare target | URL |
| --- | --- | --- | --- |
| `release` | Normal feature and fix integration | `development` / `openfloor-development` | `https://dev.app.opnflr.com` |
| `main` | Deployed production history | default / `openfloor` | `https://app.opnflr.com` |
| `hotfix/*` | Emergency work branched from `main` | none until merged to `main` | none |

Feature branches start from and open pull requests into `release`. A reviewed
`release` → `main` pull request promotes the exact release tree to production.
Production hotfixes start from `main`, target `main`, and are followed immediately
by a `main` → `release` synchronization pull request. Do not squash either
cross-branch synchronization: preserving ancestry prevents later promotions from
reintroducing already shipped commits. Feature pull requests into `release` may
be squash-merged.

The repository's own GitHub integration always uses the repository default
branch and does not offer a caller-selected base ref. Make `release` the GitHub
default so ordinary openfloor-generated work targets the integration lane.
Until base-ref selection is deliberately implemented, create `main` hotfixes
through GitHub or another Git client rather than an openfloor session.

## One-time external setup

Complete these steps before the first push to `release`. The repository contains
the deployment logic, but secrets, Access policy, and GitHub administrative
settings remain external authority.

### 1. Cloudflare development resources

`wrangler.jsonc` references the existing empty D1 database
`openfloor-development` (`fe7e3046-8cd8-4aae-a226-87534b2d9f15`). Confirm it is
present, then create the two private development buckets if they do not exist:

```bash
npx wrangler d1 list
npx wrangler r2 bucket create openfloor-development-preflight-logs
npx wrangler r2 bucket create openfloor-development-user-avatars
```

The first successful development deploy creates the Worker, Durable Object
namespaces, Workflows, container application, and custom domain from
`wrangler.jsonc`. Do not deploy it before Access is configured for the hostname.

### 2. Cloudflare Access

Create one self-hosted Access application for development, matching production's
current one-application topology. Give it exactly these two destinations:

- `dev.app.opnflr.com/api/*`
- `dev.app.opnflr.com/auth/complete`

Production's current policy is Allow → Include `Everyone`, with application
admission enforced separately in D1. Development deliberately starts with its
D1 early-access gate off, so do **not** copy `Everyone`: allow only named
developers/testers or a dedicated development Access group.

Leave Cookie Path Attribute off and leave Zero Trust's Require Access Protection
setting off. Hide the development application from the App Launcher unless its
launcher target is explicitly set to a real page. Do not add `/`, `/home*`,
`/settings*`, `/onboarding*`, `/session/*`, `/join/*`, `/signin*`, `/signout`,
`/early-access*`, static assets, `/webhooks/*`, or `/runtime/*`. Real pages live
outside Access and authenticate from the signed `CF_Authorization` cookie minted
through `/auth/complete`; `/api/*` receives Access's assertion header directly.
See `docs/cloudflare-access-config.md` for the complete trust boundary.

Record the new application's Audience tag. The development Worker secret
`CF_ACCESS_AUD` contains only that development audience; never copy the
production tag or combine environments.

### 3. Development GitHub App

Create a separate GitHub App for development using the permissions and event
subscriptions in `docs/github-production.md`, with these environment-specific
URLs:

- Homepage: `https://dev.app.opnflr.com`
- Callback: `https://dev.app.opnflr.com/api/github/callback`
- Webhook: `https://dev.app.opnflr.com/webhooks/github`

Enable device flow and request user authorization during installation, as in the
production runbook. Install this App only on disposable or development
repositories. Do not reuse the production App private key, client secret, state
secret, or webhook secret.

### 4. Development Worker secrets

Set secrets against the named Wrangler environment:

```bash
npx wrangler secret put INVITE_SIGNING_SECRET --env development
npx wrangler secret put EARLY_ACCESS_PASSWORD --env development
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN --env development
npx wrangler secret put CF_ACCESS_AUD --env development
npx wrangler secret put GITHUB_APP_ID --env development
npx wrangler secret put GITHUB_APP_SLUG --env development
npx wrangler secret put GITHUB_APP_CLIENT_ID --env development
npx wrangler secret put GITHUB_CLIENT_SECRET --env development
npx wrangler secret put GITHUB_STATE_SECRET --env development
npx wrangler secret put GITHUB_WEBHOOK_SECRET --env development
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env development < /absolute/path/to/development-private-key.pem
npx wrangler secret put RUNTIME_GATEWAY_SECRET --env development
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY --env development
```

Use newly generated values for every signing/encryption secret. Do not copy the
production waitlist Sheet destination into development. Development starts with
`EARLY_ACCESS_GATE_ENABLED=false` and `STRIPE_CHECKOUT_ENABLED=false`.
Development agent execution is enabled after the isolated runtime and identity
setup was accepted, but no shared provider fallback key is required: each
tester may connect a personal provider credential in Settings. Keep GLM, Qwen,
and DeepSeek disabled until their separate provider acceptance passes. If
billing is later tested here, use Stripe test-mode objects and a separate test
webhook only. Roll back execution by setting development
`AGENT_RUN_ENABLED=false` and deploying; do not delete run history.

### 5. GitHub deployment environments

Create GitHub Actions environments named `development` and `production`. Add
these secrets to each environment:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Use separate scoped tokens. Restrict `development` deployments to `release` and
`production` deployments to `main`. Once both environment-scoped secrets work,
remove the old repository-level Cloudflare secrets so another workflow cannot
inherit production deployment authority accidentally.

The repository is currently private on a GitHub plan that does not expose
rulesets/branch protection. Upgrade the GitHub organization plan (or make the
repository public) before treating the following rules as enforced. Protect
both `release` and `main`: require pull requests, the `Validate` status check,
resolved conversations, and block force-push and deletion. `main` PRs are also
guarded in CI and may come only from `release` or `hotfix/*`. Do not require
linear history because promotion and hotfix synchronization intentionally use
merge commits.

Keep both squash merge and merge commit enabled; disable rebase merge. Use
squash for feature PRs and merge commits only for cross-branch promotion/sync.

### 6. Bootstrap the release branch

Create `release` from the current production head only after steps 1–5 are
ready:

```bash
git fetch origin
git push origin origin/main:refs/heads/release
```

Merge this deployment change into `release`. Its push runs the complete test
gate, migrates only `openfloor-development`, verifies the development artifact,
and deploys `https://dev.app.opnflr.com`. After smoke testing succeeds, promote
with a `release` → `main` pull request. After that production deployment is
confirmed, tag its `main` commit as the `v0.1.0` baseline if that version still
matches `package.json`. Finally, set `release` as the repository default branch.

## Normal release flow

1. Branch from current `release` and open each feature/fix pull request back to
   `release`; merge only after `Validate` passes and review is complete.
2. When the integrated changes are ready to release, open a final release-prep
   PR that updates `package.json` and `package-lock.json` to the intended SemVer
   version (`npm version <version> --no-git-tag-version`).
3. Merge the release-prep PR, confirm that latest `release` push deployed
   development, and smoke test the exact version being promoted.
4. Open `release` → `main`; review and merge with a merge commit.
5. Confirm the production deployment succeeds.
6. Tag that successful production commit and create the GitHub Release:

```bash
git fetch origin
git tag -a v0.2.0 origin/main -m "openfloor v0.2.0"
git push origin v0.2.0
gh release create v0.2.0 --verify-tag --generate-notes
```

Before 1.0, use `v0.MINOR.0` for normal feature releases and
`v0.MINOR.PATCH` for production hotfixes. Tags are immutable production release
identity; the package version alone is not proof that a deployment succeeded.

## Production hotfix flow

```bash
git fetch origin
git switch --create hotfix/short-description origin/main
```

Make the narrow fix, increment the patch version, and open the PR directly to
`main`. After the production deployment succeeds, tag it, then open and merge a
`main` → `release` synchronization PR with a merge commit. Never leave the
hotfix only on `main`, or the next normal promotion may regress it.

## Migration and rollback rules

Development and production have separate D1 databases, R2 buckets, Workflows,
Durable Objects, and runtime secrets. Development migrations run before its
Worker deploy; production migrations run again against production before its
deploy. Migrations must remain compatible with the currently deployed Worker
during either rollout.

Rollback application code with a new revert/hotfix commit and let the normal
lane deploy it. Do not move release tags. Cloudflare Worker version rollback is
safe only for a code-only release whose prior Worker remains compatible with all
already-applied D1 and Durable Object migrations; it is not a database rollback.

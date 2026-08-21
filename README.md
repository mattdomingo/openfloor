# openfloor

openfloor is a persistent multiplayer session shell for teams coordinating agent work. Cloudflare D1 stores users, sessions, memberships, reusable signed invites, agents, assignments, prompts, queue ordering, and team/direct messages. A per-session Durable Object provides live WebSocket presence and floor-change notifications.

Members enter a session at `/app/session/[id]`, then continue to the authenticated workspace at `/app/session/[id]/floor`. A new floor starts empty. Everything shown comes from the session, persisted member actions, or a connected backend; openfloor does not seed sample agents, prompts, files, checks, or review candidates.

## Local development

Install dependencies and create an ignored local environment file:

```bash
npm install
cp .env.example .dev.vars
openssl rand -hex 32
```

Open `.dev.vars` and replace `INVITE_SIGNING_SECRET` with the random value printed by the last command. You can also change the three `OPENFLOOR_DEV_USER_*` values to the local name and email you want displayed. The Cloudflare Access placeholders can remain unchanged for local development.

Repository execution additionally requires a GitHub App, Cloudflare Workflows/Sandbox/private R2, and an OpenAI project API key. Follow [`docs/github-production.md`](docs/github-production.md). Owners name each candidate and describe its intent, with the session title and objective supplied as defaults; openfloor safely slugs the name inside its protected branch prefix and uses the metadata for the draft pull request. openfloor runs Codex at an exact candidate SHA, validates and publishes each passing result independently, serially integrates it into one draft pull request, reconciles GitHub files/checks/mergeability, and lets only the session owner mark ready and request a protected squash merge. Confirmed merges clean only exact-SHA openfloor branches and the next run starts a fresh candidate cycle.

Create the local D1 tables, then start the development server:

```bash
npx wrangler d1 migrations apply openfloor-production --local
npm run dev
```

Open the URL printed by the server, normally [http://localhost:3000](http://localhost:3000). Local development serves the application at the root, so use `/home` rather than `/app/home`; the `/app` prefix is added by production builds. You are automatically signed in with the identity from `.dev.vars`.

To exercise the new path manually:

1. Open `/home` and create a session.
2. On the session lobby, click **Enter agent floor**.
3. Confirm the floor shows the real session title, objective, and your online presence.
4. Create a named agent, add assigned or unassigned prompts, edit an assignment, and use team chat. Reload and confirm they persist.
5. Open Review and confirm it remains empty until a genuine agent run records changed files.
6. Use **Session settings** to return to the lobby.

The browser test runs the complete two-user flow with a temporary local database, including invite acceptance, live presence, floor navigation, reconnection, and leaving:

```bash
npm run test:e2e
```

Run every check with:

```bash
npm test
```

## Cloudflare Access

Production authentication is provided by one Cloudflare Access self-hosted application. Keep the public landing page and assets outside Access, and add these protected public hostnames to the same application so they share one audience tag:

- `opnflr.com/app/home`
- `opnflr.com/app/session/*`
- `opnflr.com/app/join/*`
- `opnflr.com/app/api/*`

Enable Google and One-time PIN as identity providers. The application policy determines who may authenticate; session membership and invite acceptance remain enforced by openfloor.

Copy the Access team domain and the application's Audience (AUD) tag into Worker secrets:

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

`CF_ACCESS_TEAM_DOMAIN` must be the full origin, for example `https://your-team.cloudflareaccess.com`. The Worker validates the Access JWT signature, issuer, audience, and expiry before forwarding trusted identity to the application.

## Test and deploy

```bash
npm test
npx wrangler d1 migrations apply openfloor-production --remote
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

Apply D1 migrations before deploying the Worker revision. See [`docs/agent-backend-gaps.md`](docs/agent-backend-gaps.md) for the intentional boundary between the persistent collaboration backend and future agent execution.

The deployment expects `DB`, `SESSION_PRESENCE`, `REPOSITORY_PREFLIGHT`, `AGENT_RUN_WORKFLOW`, `SANDBOX`, `PREFLIGHT_LOGS`, `IMAGES`, and `ASSETS` bindings configured in `wrangler.jsonc`. It also requires the existing identity/GitHub secrets plus `RUNTIME_GATEWAY_SECRET` and `OPENAI_API_KEY`. Docker must be running when Wrangler builds or deploys the pinned Sandbox image, and the Cloudflare account must have Workers Paid/Containers access. Keep each rollout gate disabled until its image, Workflow, and credential prerequisites are live.

### Grant a plan after purchase

There is no billing webhook yet — the Stripe payment link in the product takes payment but changes nothing in openfloor by itself. Every purchase needs this checklist run by hand:

1. **Watch the Stripe dashboard** for the completed payment and note the payer's email.
2. **Confirm the buyer has an openfloor account.** They must have signed in at least once — `users` has no row for an email that has never authenticated. If they haven't signed in yet, ask them to, then continue.
3. **Grant the plan**, setting `plan` and `plan_status` together (a plan alone grants nothing — see "Plan limits and metering" in [`AGENTS.md`](AGENTS.md)):
   ```bash
   npx wrangler d1 execute openfloor-production --remote --command \
     "UPDATE users SET plan='pro', plan_status='active' WHERE email='<buyer-email>'"
   ```
4. **Check the output for `"changes": 1`.** `0` means step 2's email didn't match any row — the buyer's account email may differ from their payment email; look them up by name/GitHub handle instead of re-running blindly.
5. **Confirm with the buyer** that `/home` now shows their plan and limits.

The payment link sells exactly one tier. Selling a second tier (e.g. Max) needs a second Stripe payment link and a way to tell them apart when running step 3 — the current single link and this runbook only cover Pro.

## Project direction

See [`AGENTS.md`](AGENTS.md) for the product vision, system architecture, engineering invariants, key decisions, and roadmap guidance.

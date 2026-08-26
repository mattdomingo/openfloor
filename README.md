# openfloor

openfloor is a persistent multiplayer session shell for teams coordinating agent work. Cloudflare D1 stores users, sessions, memberships, reusable signed invites, agents, assignments, prompts, queue ordering, and team/direct messages. A per-session Durable Object provides live WebSocket presence and floor-change notifications.

Members enter a session at `/app/session/[id]`, then continue to the authenticated workspace at `/app/session/[id]/floor`. A new floor starts empty. Everything shown comes from the session, persisted member actions, or a connected backend; openfloor does not seed sample agents, prompts, files, checks, or review candidates.

Creating a session sends its owner to `/session/[id]?setup=1` and opens the lobby’s two-step setup: connect and enable the required GitHub repository, then optionally connect the owner’s model-provider API keys and choose the default for generated agents. One connected, rollout-enabled provider is selected automatically; multiple require an explicit default; zero use the existing OpenAI owner-key/server-key/refuse ladder. “Set up later” leaves the lobby usable and removes the query state. Provider keys remain per-user. Returning members never enter this creation flow automatically, and entering the live floor still requires the existing repository-ready invariant.

The Agent Floor keeps persistent user-created agents and **New agent** unchanged. When the owner enables both auto-dispatch and **Auto agents**, routing assigns idle persistent agents first, then activates durable generated workers for additional tasks. Generated workers and Concierge carry an **Auto-generated** badge, retire when idle, and are reused without losing queue/run attribution. Concierge handles only read-only reply runs and can never publish code changes. Automated scheduling is capped at 15 active runs per session and 30 globally.

## Local development

Install dependencies and create an ignored local environment file:

```bash
npm install
cp .env.example .dev.vars
openssl rand -hex 32
```

Open `.dev.vars` and replace `INVITE_SIGNING_SECRET` with the random value printed by the last command. You can also change the three `OPENFLOOR_DEV_USER_*` values to the local name and email you want displayed. The Cloudflare Access placeholders can remain unchanged for local development.

Repository execution additionally requires a GitHub App, Cloudflare Workflows/Sandbox/private R2, and an OpenAI project API key. Follow [`docs/github-production.md`](docs/github-production.md). Self-serve paid plans require Stripe products, prices, Portal configuration, secrets, and a signed webhook; follow [`docs/stripe-billing.md`](docs/stripe-billing.md). Keep `STRIPE_CHECKOUT_ENABLED=false` until that runbook is complete.

Owners name each candidate and describe its intent, with the session title and objective supplied as defaults; openfloor safely slugs the name inside its protected branch prefix and uses the metadata for the draft pull request. openfloor runs Codex at an exact candidate SHA, validates and publishes each passing result independently, serially integrates it into one draft pull request, reconciles GitHub files/checks/mergeability, and lets only the session owner mark ready and request a protected squash merge. Before final merge, the session owner, an agent owner, or the engineer who authored every prompt in an integrated run can roll that run back: required checks run on a deterministic inverse commit, a separate trusted publisher advances only the expected candidate SHA, and the original run/branch audit remains intact. Confirmed merges clean only exact-SHA openfloor branches and the next run starts a fresh candidate cycle.

A real GitHub integration conflict creates one durable merge-conflict case attached to the original queue item. Automatic conflict resolution is enabled by default, independent from ordinary queue auto-dispatch, and runs ahead of new queue work when capacity and provider gates allow. The resolver inherits the source agent, provider/model, and agent-owner credential policy; reconstructs a genuine three-way merge from the exact source result and latest candidate; runs configured checks; and publishes through the same verified branch pipeline. When repository intent is ambiguous, it stops without publishing and asks up to three questions in Review. Any current member may answer, while only the owner may manually start or retry a case. Browser conflict alerts are an optional per-device setting and require an explicit permission-granting click.

Create the local D1 tables, then start the development server:

```bash
npx wrangler d1 migrations apply openfloor-production --local
npm run dev
```

Open the URL printed by the server, normally [http://localhost:3000](http://localhost:3000). Local development serves the application at the root, so use `/home` rather than `/app/home`; the `/app` prefix is added by production builds. You are automatically signed in with the identity from `.dev.vars`.

To exercise the product manually:

1. Open `/home` and create a session.
2. Confirm the owner-only setup dialog opens. Connect a repository and create its candidate branch; connect or choose the generated-agent provider when applicable, or choose **Set up later** and reopen **Setup** from the lobby.
3. Click **Enter agent floor**. Without a ready repository, confirm only the focused repository-required dialog opens.
4. Confirm the floor shows the real session title, objective, and your online presence.
5. Confirm **New agent** still creates a persistent named agent. Turn on auto-dispatch and **Auto agents**, add more unassigned tasks than idle persistent agents, and confirm generated workers appear with badges and disappear after work finishes.
6. Open Review and confirm it remains empty until a genuine agent run records changed files.
7. In Queue settings, confirm **Automatically resolve merge conflicts** is on by default and browser alerts remain off until explicitly enabled.
8. Use **Session settings** to return to the lobby.

The browser test runs the complete two-user flow with a temporary local database, including invite acceptance, live presence, floor navigation, reconnection, and leaving:

```bash
npm run test:e2e
```

Run every check with:

```bash
npm test
```

## Record the website demo

Generate the matched Agent Floor cuts in Polar and Midnight with
`npm run demo:record`. The isolated recording workflow never touches
production or GitHub. See [`docs/website-demo-video.md`](docs/website-demo-video.md)
for the capture boundary, outputs, and voiceover.

## Cloudflare Access

Production authentication is provided by Cloudflare Access, applied as an **explicit allowlist of protected paths, not a protect-everything-then-bypass setup**. A path Cloudflare Access has no destination for is not specially exempted — it simply never goes through Access and reaches the Worker directly. That's what keeps the public landing page (`/`), static assets, `/webhooks/*`, and `/runtime/*` public: none of them are listed in any Access application. (A blank or `*` Path is *not* a way to scope a destination to "just the root" — per Cloudflare's own docs, `example.com` and `example.com/*` are equivalent and both mean the hostname plus everything beneath it. There is no root-only destination syntax.)

Self-hosted applications cap at five destinations each, and there are six protected paths, so this uses two applications sharing one policy — attach the existing policy to the second app via "Add existing policy" rather than duplicating it:

- App 1 ("OpenFloor authenticated users"): `app.opnflr.com/home`, `app.opnflr.com/settings`, `app.opnflr.com/onboarding`, `app.opnflr.com/session/*`, `app.opnflr.com/join/*`
- App 2 (same policy attached): `app.opnflr.com/api/*`

This path list is manually maintained in the Access applications, not covered by a wildcard — every new protected page needs its path added to whichever app has room (or a new app sharing the policy) here (and in the two copies of this list in `AGENTS.md` and `docs/github-production.md`) in the same change, or the page bounces every visitor back to sign-in.

Check Zero Trust → Settings → "Require Access Protection" is off. If it's on, an unmatched hostname/path is blocked (error 1050) instead of passed through, which breaks the "unlisted = public" assumption this setup relies on.

App 2's only destination is a wildcard path, so its App Launcher tile would otherwise be the literal, unroutable `app.opnflr.com/api/*`. Turn off App 2's **Experience settings → "Show application in App Launcher"** so the launcher only ever offers App 1's real tile. Also leave **Cookie Path Attribute** off on both apps, or moving between App 1's paths and App 2's forces re-authentication on every crossing.

Enable Google and One-time PIN as identity providers. The application policy determines who may authenticate; session membership and invite acceptance remain enforced by openfloor.

Sign out through the app's own `/signout` route, not Cloudflare's `/cdn-cgi/access/logout` directly — neither Access logout endpoint accepts a return URL, and the app-domain one alone leaves the team-domain global session (and therefore silent re-authentication on the next sign-in) intact. `/signout` clears the app-domain cookie and hands off to the team-domain logout itself.

Copy the Access team domain and both applications' Audience (AUD) tags into Worker secrets:

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

`CF_ACCESS_TEAM_DOMAIN` must be the full origin, for example `https://your-team.cloudflareaccess.com`. `CF_ACCESS_AUD` is comma-separated, one tag per Access application, e.g. `app-1-aud,app-2-aud` — a page load and its first `/api` call can each carry a JWT minted for a different app. The Worker validates the Access JWT signature, issuer, audience (against either tag), and expiry before forwarding trusted identity to the application.

## Test and deploy

```bash
npm test
npx wrangler d1 migrations apply openfloor-production --remote
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

Apply D1 migrations before deploying the Worker revision. See [`docs/agent-backend-gaps.md`](docs/agent-backend-gaps.md) for the intentional boundary between the persistent collaboration backend and future agent execution.

The deployment expects `DB`, `SESSION_PRESENCE`, `REPOSITORY_PREFLIGHT`, `AGENT_RUN_WORKFLOW`, `SANDBOX`, `PREFLIGHT_LOGS`, `IMAGES`, and `ASSETS` bindings configured in `wrangler.jsonc`. It also requires the existing identity/GitHub secrets plus `RUNTIME_GATEWAY_SECRET`, `OPENAI_API_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, the optional `ANTHROPIC_API_KEY` fallback, and the Stripe secrets documented in [`docs/stripe-billing.md`](docs/stripe-billing.md). Docker must be running when Wrangler builds or deploys the pinned Sandbox image, and the Cloudflare account must have Workers Paid/Containers access. Keep each rollout gate disabled until its service and credential prerequisites are live.

## Project direction

See [`AGENTS.md`](AGENTS.md) for the product vision, system architecture, engineering invariants, key decisions, and roadmap guidance.

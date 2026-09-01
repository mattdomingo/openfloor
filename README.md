# openfloor

openfloor is a persistent multiplayer session shell for teams coordinating agent work. Cloudflare D1 stores users, early-access admission and waitlist state, sessions, memberships, reusable signed invites, agents, assignments, prompts, queue ordering, and team/direct messages. A per-session Durable Object provides live WebSocket presence and floor-change notifications.

Members enter a session at `/app/session/[id]`, then continue to the authenticated workspace at `/app/session/[id]/floor`. A new floor starts empty. Everything shown comes from the session, persisted member actions, or a connected backend; openfloor does not seed sample agents, prompts, files, checks, or review candidates.

Every new account completes Profile, GitHub App installation, then Plan onboarding. GitHub access is account-level, may include multiple personal or organization installations, and stores no GitHub user token. Session creation requires choosing an authorized repository, verifies its default branch and head, reserves the session/repository/candidate in D1, creates the server-owned candidate branch, then opens the normal ready lobby. Existing users may keep using old sessions but cannot create a new one until Account Settings has active GitHub access. Provider keys remain per-user and are managed separately in Settings.

The Agent Floor keeps persistent user-created agents and **New agent** unchanged. A new persistent agent is always owned by its creator: teammates can edit its task and use Pause/Stop as safety controls, but only its recorded owner can change model/billing or Resume it. When the owner enables both auto-dispatch and **Auto agents**, routing assigns idle persistent agents first, then activates durable generated workers for additional tasks. Generated workers and Concierge carry an **Auto-generated** badge, retire when idle, and are reused without losing queue/run attribution. Multiple simultaneous questions receive separate Concierge agents within the existing run limits; each Concierge retires after its reply. Concierge handles only read-only reply runs and can never publish code changes. Stop also pauses and only a session-owner click cancels the current run. Generated workers remain read-only and non-deletable. Automated scheduling is capped at 15 active runs per session and 30 globally.

## Local development

Install dependencies and create an ignored local environment file:

```bash
npm install
cp .env.example .dev.vars
openssl rand -hex 32
```

Open `.dev.vars` and replace `INVITE_SIGNING_SECRET` with the random value printed by the last command. You can also change the three `OPENFLOOR_DEV_USER_*` values to the local name and email you want displayed. The Cloudflare Access placeholders can remain unchanged for local development.

The early-access gate is committed off for its first rollout. `/early-access` and local passcode testing use `EARLY_ACCESS_PASSWORD`; production Sheet, WAF, operator, rollout, and rollback setup is in [`docs/early-access.md`](docs/early-access.md).

Repository execution additionally requires a GitHub App, Cloudflare Workflows/Sandbox/private R2, and an OpenAI project API key. Sandbox image `v9` separates token-bearing provider CLIs from repository commands by Linux uid and CI tests the boundary adversarially. Production `AGENT_RUN_ENABLED` remains false until that image is deployed, every enabled provider passes disposable-repository acceptance, and a separate authorized change flips the gate. Follow [`docs/github-production.md`](docs/github-production.md). Self-serve paid plans require Stripe products, prices, Portal configuration, secrets, and a signed webhook; follow [`docs/stripe-billing.md`](docs/stripe-billing.md). Keep `STRIPE_CHECKOUT_ENABLED=false` until that runbook is complete.

Candidate name and description come from the session title and objective; openfloor safely slugs the name inside its protected branch prefix and uses the metadata for the draft pull request. openfloor runs Codex at an exact candidate SHA, validates and publishes each passing result independently, serially integrates it into one draft pull request, reconciles GitHub files/checks/mergeability, and lets only the session owner mark ready and request a protected squash merge. Review can be organized by Files or Prompts and attributes each integrated group to its human engineer(s) and software agent while retaining the exact historical run diff. Before final merge, the session owner, an agent owner, or the engineer who authored every prompt in an integrated group can remove that group. The owner can atomically remove all solely-authored groups for an engineer or every active group from one agent; mixed-author engineer groups remain active and are reported as exclusions. A separate trusted publisher reconstructs the newest-first deterministic inverse commit and advances only the previewed expected candidate SHA, and the original prompt/run/branch/rollback audit remains intact under History. Confirmed merges clean only exact-SHA openfloor branches and the next run starts a fresh candidate cycle.

A real GitHub integration conflict creates one durable merge-conflict case attached to the original queue item. Automatic conflict resolution is enabled by default, independent from ordinary queue auto-dispatch, and runs ahead of new queue work when capacity and provider gates allow. The resolver inherits the source agent, provider/model, and agent-owner credential policy; reconstructs a genuine three-way merge from the exact source result and latest candidate; and publishes through the same branch pipeline. Contradictory authored outcomes always stop without publishing and ask up to three questions in Review; prompt chronology cannot silently select a winner unless an author explicitly superseded earlier intent. The session owner or any current original prompt author may answer, while only the owner may manually start or retry a case. Other members can inspect and discuss it. Browser conflict alerts are an optional per-device setting and require an explicit permission-granting click.

Create the local D1 tables, then start the development server:

```bash
npx wrangler d1 migrations apply openfloor-production --local
npm run dev
```

Open the URL printed by the server, normally [http://localhost:3000](http://localhost:3000). Local development serves the application at the root, so use `/home` rather than `/app/home`; the `/app` prefix is added by production builds. You are automatically signed in with the identity from `.dev.vars`.

To exercise the product manually:

1. Complete onboarding and install the GitHub App before choosing a plan.
2. In `/home`, create a session and select an account-authorized repository. Confirm the normal lobby opens with the default branch and an active candidate; no setup dialog should appear.
3. Click **Enter agent floor**. For a legacy or failed-provision session without a ready candidate, confirm only the focused repository-required dialog opens and the lobby offers retry or Account Settings guidance.
4. Confirm the floor shows the real session title, objective, and your online presence.
5. Confirm **New agent** still creates a persistent named agent. Turn on auto-dispatch and **Auto agents**, add more unassigned tasks than idle persistent agents, and confirm generated workers appear with badges and disappear after work finishes. Pause a worker and confirm its current run finishes while no new work is assigned; Resume starts future dispatch again. Stop as a member and confirm only future work is blocked, then Stop as owner and confirm the current run is cancelled.
6. Open Review and confirm it remains empty until a genuine agent run records changed files. After integrating multiple prompts, switch between Files and Prompts; confirm changed-file contribution cards identify the prompts, engineers, and software agents, and prompt detail shows the original historical diff. As the owner, preview an engineer or agent **Remove all changes** action and verify its exact prompts, files, and mixed-author exclusions before confirming.
7. Submit two questions back-to-back and confirm two Concierge agents answer concurrently, retire when done, and later questions reuse retired Concierge rows. Confirm answered prompts are subdued at the completed end of the queue.
8. From a completed Queue item authored entirely by the signed-in engineer, click **Remove changes**, verify the impact dialog, and confirm it. The item must stay completed and gray with **Rolled back**; Review must remove it from Active and retain it under Prompts → History. Team cards and agent spotlight must have no rollback shortcut.
9. In Queue settings, confirm **Automatically resolve merge conflicts** is on by default and browser alerts remain off until explicitly enabled. Create contradictory authored outcomes and confirm only the owner or an original prompt author sees the answer form.
10. Use **Session settings** to return to the lobby.

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

Production authentication is provided by Cloudflare Access, applied as an **explicit allowlist of protected paths, not a protect-everything-then-bypass setup**. A path Cloudflare Access has no destination for is not specially exempted — it simply never goes through Access and reaches the Worker directly. That's what keeps the public landing page (`/`), early-access flow (`/early-access*`), static assets, `/webhooks/*`, and `/runtime/*` public: none of them are listed in any Access application. (A blank or `*` Path is *not* a way to scope a destination to "just the root" — per Cloudflare's own docs, `example.com` and `example.com/*` are equivalent and both mean the hostname plus everything beneath it. There is no root-only destination syntax.)

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
npm audit --omit=dev
npm test
npx wrangler d1 migrations apply openfloor-production --remote
npm run build
npm run verify:deploy-artifact
npx wrangler deploy --config dist/server/wrangler.json
```

The production dependency audit and full test pipeline must pass before applying D1 migrations; apply migrations before deploying the Worker revision. `npm run test:e2e` rebuilds `dist/` with the E2E Wrangler config, so always rebuild and run `npm run verify:deploy-artifact` — it requires the exact production worker, route, D1 database ID, and disabled agent-run security gate, and refuses test-only vars. Pull requests verify the production artifact before E2E replaces it, while pushes to `main` rebuild and verify again before deployment. See [`docs/agent-backend-gaps.md`](docs/agent-backend-gaps.md) for the intentional boundary between the persistent collaboration backend and future agent execution.

The deployment expects `DB`, `SESSION_PRESENCE`, `REPOSITORY_PREFLIGHT`, `AGENT_RUN_WORKFLOW`, `SANDBOX`, `PREFLIGHT_LOGS`, `USER_AVATARS`, `IMAGES`, and `ASSETS` bindings configured in `wrangler.jsonc`. It also requires the existing identity/GitHub secrets plus `EARLY_ACCESS_PASSWORD`, `WAITLIST_SHEET_WEBHOOK_URL`, `WAITLIST_SHEET_WEBHOOK_SECRET`, `RUNTIME_GATEWAY_SECRET`, `OPENAI_API_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, the optional `ANTHROPIC_API_KEY` fallback, and the Stripe secrets documented in [`docs/stripe-billing.md`](docs/stripe-billing.md). Docker must be running when Wrangler builds or deploys the pinned Sandbox image, and the Cloudflare account must have Workers Paid/Containers access. Keep each rollout gate disabled until its service, credential, and security prerequisites are live.

## Project direction

See [`AGENTS.md`](AGENTS.md) for the product vision, system architecture, engineering invariants, key decisions, and roadmap guidance.

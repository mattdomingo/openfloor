# OpenFloor

OpenFloor is a persistent multiplayer session shell for teams coordinating agent work. Cloudflare D1 stores users, sessions, memberships, reusable signed invites, agents, assignments, prompts, queue ordering, and team/direct messages. A per-session Durable Object provides live WebSocket presence and floor-change notifications.

Members enter a session at `/app/session/[id]`, then continue to the authenticated workspace at `/app/session/[id]/floor`. A new floor starts empty. Everything shown comes from the session, persisted member actions, or a connected backend; OpenFloor does not seed sample agents, prompts, files, checks, or review candidates.

## Local development

Install dependencies and create an ignored local environment file:

```bash
npm install
cp .env.example .dev.vars
openssl rand -hex 32
```

Open `.dev.vars` and replace `INVITE_SIGNING_SECRET` with the random value printed by the last command. You can also change the three `OPENFLOOR_DEV_USER_*` values to the local name and email you want displayed. The Cloudflare Access placeholders can remain unchanged for local development.

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
5. Open Review and confirm it remains empty until a real agent backend supplies review data.
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

Enable Google and One-time PIN as identity providers. The application policy determines who may authenticate; session membership and invite acceptance remain enforced by OpenFloor.

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

The deployment expects the `DB`, `SESSION_PRESENCE`, `IMAGES`, and `ASSETS` bindings configured in `wrangler.jsonc`, plus `INVITE_SIGNING_SECRET`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` as Worker secrets.

## Project direction

See [`docs/project-context.md`](docs/project-context.md) for the broader product model and roadmap.

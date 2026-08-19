# OpenFloor

OpenFloor is a persistent multiplayer session shell for teams coordinating agent work. Cloudflare D1 stores users, sessions, memberships, and reusable signed invites. A per-session Durable Object provides live WebSocket presence.

## Local development

Copy `.env.example` to an ignored `.dev.vars` file and set a long random invite-signing secret. The explicit development identity is accepted only by the local server.

```bash
npm install
npm run dev
```

Open the local URL printed by the development server.

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
npm run build
npx wrangler deploy --config dist/server/wrangler.json
```

The deployment expects the `DB`, `SESSION_PRESENCE`, `IMAGES`, and `ASSETS` bindings configured in `wrangler.jsonc`, plus `INVITE_SIGNING_SECRET`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` as Worker secrets.

## Project direction

See [`docs/project-context.md`](docs/project-context.md) for the broader product model and roadmap.

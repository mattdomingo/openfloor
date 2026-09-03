# Cloudflare Access configuration

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size
> threshold. This is the authoritative source for Access applications,
> destinations, and policy topology; keep it factually correct.

## Production topology

Production uses one self-hosted Access application named `openfloor` with two
destinations:

- `app.opnflr.com/api/*`
- `app.opnflr.com/auth/complete`

Its Allow policy currently includes `Everyone`. That is an authentication
policy, not product admission: GitHub and One-time PIN are the enabled identity
providers, while D1 early-access grants and session membership decide what an
authenticated account may use.

Every real page (`/home`, `/settings`, `/onboarding`, `/session/*`, `/join/*`)
is deliberately outside Access. A signed-out page request therefore reaches the
Worker and is routed through openfloor's own landing/sign-in UI. All sign-in
flows anchor on `/auth/complete`; Access sets `CF_Authorization` there and the
route immediately returns the browser to the requested page. On page requests,
the Worker reads that cookie and verifies the same signature, issuer, audience,
and expiry that it verifies on Access's `cf-access-jwt-assertion` header.
`/api/*` remains directly protected by Access and normally carries the header.

The public landing page, `/early-access*`, `/signin`, `/signin/code`, `/signout`,
static assets, `/webhooks/*`, and `/runtime/*` are also outside Access. Webhooks
verify provider signatures, runtime routes verify operation-bound bearer tokens,
and unsafe browser mutations are same-origin checked by the Worker.

This is an explicit destination allowlist, not a protect-everything application
with bypass rules. Cloudflare has no root-only destination syntax: a blank path
and `*` both cover the whole hostname. Zero Trust → Settings → **Require Access
Protection** must stay off so unmatched paths reach the Worker. **Cookie Path
Attribute** must stay off so the cookie minted at `/auth/complete` is sent to
pages outside that path. Hide the application from the App Launcher unless its
launcher target is explicitly set to a real page; `/api/*` is not a usable
entry point.

## Development topology

Development mirrors the one-application/two-destination shape at:

- `dev.app.opnflr.com/api/*`
- `dev.app.opnflr.com/auth/complete`

Unlike production, its Allow policy must include only named developers/testers
or a dedicated Access group—not `Everyone`. Development starts with the D1
early-access gate off, so the Access policy is the environment's outer admission
boundary. It has its own audience tag and Worker secret; never put the production
and development audiences in the same environment's `CF_ACCESS_AUD`.

## Worker identity and sign-out

Set `CF_ACCESS_TEAM_DOMAIN` to the full `https://<team>.cloudflareaccess.com`
origin. Set `CF_ACCESS_AUD` to the target application's Audience tag. The Worker
still accepts a comma-separated audience list to support safe audience rotation,
but each steady-state environment currently needs one tag.

The provider user ID is stored as `cloudflare-access:<sub>`. Email and name are
mutable display metadata, not identity keys.

Sign out through `/signout`, never `/cdn-cgi/access/logout` directly. The owned
route clears the application-domain cookie, ends the team-domain global session,
and returns to openfloor's landing page. It must remain outside Access so a
signed-out browser can reach it.

## Identity-provider behavior

`/signin` presents GitHub as the primary control and One-time PIN as the fallback.
Both still authenticate through Cloudflare Access. The custom email form parses
only Cloudflare's form action, validates it against `CF_ACCESS_TEAM_DOMAIN`, and
degrades to the hosted Access screen if Cloudflare's markup changes. GitHub OAuth
stays a direct browser navigation because its callback requires the team-domain
session cookie.

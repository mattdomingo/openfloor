# System Architecture: Hosting Topology

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size threshold. This is the
> authoritative source for hosting topology — keep it factually correct the same way `CLAUDE.md`
> itself must stay correct (update it in the same change as any behavior it describes).

---

## Important hosting topology

- The marketing site owns the apex `opnflr.com` deployment (a separate Cloudflare Pages project, repo `openfloor-ai/openfloor.ai`).
- The openfloor application is a sibling deployment on its own subdomain, `app.opnflr.com`, claimed by a Workers custom domain — not a path nested under the marketing site.
- `next.config.ts` sets `basePath` to `components/basePath.ts`'s `BASE_PATH`, which is `""` in every environment now that the app owns its own origin.
- `components/basePath.ts` exists for literal public/API/WebSocket paths that the framework does not rewrite automatically; it's kept wired through (typed `: string` so truthiness checks on it don't narrow to `never`) so remounting under a path prefix again is a one-line change.
- Use Next `Link` with unprefixed application paths such as `/home` and `/session/...`; Next applies `BASE_PATH` automatically.
- Use `BASE_PATH` for manual `fetch`, `WebSocket`, and `public/` URLs.
- `wrangler.jsonc` claims `app.opnflr.com` via a `custom_domain: true` route, which has Cloudflare provision and own the DNS record. There is no longer a marketing-site path prefix to reserve or guard against collisions.
- Asset `not_found_handling` must remain `none` so asset requests that miss the static bundle can fall through to the Worker and be resolved through `ASSETS`.
- `.openai/hosting.json` and `build/sites-vite-plugin.ts` package generic binding metadata and migrations during builds. No account-specific Sites project ID is checked in. The current production runbook deploys the built Worker directly with Wrangler because Durable Object presence is required. Do not switch the deployment path without proving D1, Durable Object, Access, asset, and route behavior end to end.

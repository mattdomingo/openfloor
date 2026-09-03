# System Architecture: Hosting Topology

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size threshold. This is the
> authoritative source for hosting topology — keep it factually correct the same way `CLAUDE.md`
> itself must stay correct (update it in the same change as any behavior it describes).

---

## Important hosting topology

### Important hosting topology

- The marketing site owns the apex `opnflr.com` deployment (a separate Cloudflare Pages project, repo `openfloor-ai/openfloor.ai`).
- The production openfloor application is a sibling deployment on its own subdomain, `app.opnflr.com`, claimed by a Workers custom domain — not a path nested under the marketing site.
- The permanent `release` branch deploys the named Wrangler `development` environment to `dev.app.opnflr.com`; `main` deploys the top-level production environment. Development has its own Worker, D1 database, R2 buckets, Workflows, Durable Object namespaces, container state, Access applications/audiences, GitHub App, and runtime secrets. Only the stateless application code and Images transform service are shared.
- `next.config.ts` sets `basePath` to `components/basePath.ts`'s `BASE_PATH`, which is `""` in every environment now that the app owns its own origin.
- `components/basePath.ts` exists for literal public/API/WebSocket paths that the framework does not rewrite automatically; it's kept wired through (typed `: string` so truthiness checks on it don't narrow to `never`) so remounting under a path prefix again is a one-line change.
- Use Next `Link` with unprefixed application paths such as `/home` and `/session/...`; Next applies `BASE_PATH` automatically.
- Use `BASE_PATH` for manual `fetch`, `WebSocket`, and `public/` URLs.
- `wrangler.jsonc` claims `app.opnflr.com` for production and `dev.app.opnflr.com` for the named development environment through separate `custom_domain: true` routes, which have Cloudflare provision and own their DNS records. There is no marketing-site path prefix to reserve or guard against collisions.
- Asset `not_found_handling` must remain `none` so asset requests that miss the static bundle can fall through to the Worker and be resolved through `ASSETS`.
- `.openai/hosting.json` and `build/sites-vite-plugin.ts` package Sites metadata and migrations during builds, but the current production runbook deploys the built Worker directly with Wrangler because Durable Object presence is a required capability. Do not switch the deployment path without proving D1, Durable Object, Access, asset, and route behavior end to end.
- Early-access admission is application-owned D1 state layered after Cloudflare Access identity. The public `/early-access` flow enters Access only through the existing protected `/auth/complete` route; Access dashboard destinations remain unchanged. The company Google Sheet receives timestamped HMAC-signed mirrors from D1 and has no path back into application authority.
- GitHub Actions, not Cloudflare's repository integration, owns both deployments because the reviewed order is complete tests, target D1 migration, fresh build, target-specific artifact verification, then Worker deploy. See `docs/release-process.md`.

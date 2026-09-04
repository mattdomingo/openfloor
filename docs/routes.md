# Route Map

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size threshold. This is the authoritative source for the production/local route table — keep it factually correct the same way `CLAUDE.md` itself must stay correct (update it in the same change as any behavior it describes).

---

| Production route | Local dev route | Access | Purpose |
| --- | --- | --- | --- |
| `/` | `/` | Public | Product landing and entry into Cloudflare Access. |
| `/early-access` | `/early-access` | Public | Waitlist, shared beta passcode, and returning-admitted-user sign-in. Admitted authenticated users continue to `/home`. |
| `/early-access/waitlist` | `/early-access/waitlist` | Public POST | Validate and upsert name/email into the D1 waitlist, then attempt the Sheet mirror. |
| `/early-access/unlock` | `/early-access/unlock` | Public POST | Verify the server-side passcode; grant an authenticated account or set the 15-minute signed admission cookie and begin Cloudflare sign-in. |
| `/early-access/complete` | `/early-access/complete` | Public/auth-return | Consume the pending cookie after Cloudflare identity, bind access to the account, clear the cookie, and continue to onboarding or a validated return path. |
| `/home` | `/home` | Protected | Sessions where the current user is a member; session creation. |
| `/home/settings` | `/home/settings` | Protected | Account settings: profile, plan and usage, connections, preferences, and account deletion. The account menu supplies an optional membership-checked `from` path so the header can return to the originating home/session/floor page. |
| `/onboarding` | `/onboarding` | Protected | Two-step first-login setup: profile + required GitHub App installation together, then optional AI provider connections. Every signup is enrolled on Free automatically — the plan step is hidden for now (2026-08-27 decision). Gates `/home`, `/join/*`, and `/session/*` until final submission. |
| `/join/[token]` | `/join/[token]` | Protected | Valid invite preview followed by explicit acceptance. |
| `/session/[id]` | `/session/[id]` | Protected/member-only | Session lobby, roster, invite controls, leave, and floor entry. |
| `/session/[id]/floor` | `/session/[id]/floor` | Protected/member-only | Main collaborative Agent Floor. |
| `/api/...` | `/api/...` | Protected | Authenticated application interfaces. |
| `/api/sessions/[id]/presence` | `/api/sessions/[id]/presence` | Protected/member-only | WebSocket upgrade. |
| `/api/sessions/[id]/repository/preview` | `/api/sessions/[id]/repository/preview` | Protected/owner-only | Start, rebuild, or stop the session's shared exact-candidate app preview while the rollout gate is enabled. |
| `/runtime/preview/source` | `/runtime/preview/source` | Public/signed | Serve the exact candidate archive to one current preview generation through a short-lived operation token. |
| `https://*.preview.opnflr.com/*` | `https://*.preview.dev.opnflr.com/*` | Protected/member-only | Proxy one active preview host after Access identity, current membership/admission, repository/candidate, and lease checks. Both environment gates are currently off. |
| `/webhooks/github` | `/webhooks/github` | Public/signed | GitHub delivery boundary; verifies payload size and HMAC before acknowledging. |
| `/webhooks/stripe` | `/webhooks/stripe` | Public/signed | Stripe delivery boundary; caps the raw body, verifies Stripe's signature, and reconciles subscription entitlement. |

## Important behavior (route-level invariants)

“Protected” in this table means the application requires a verified Access
identity; it does not mean every page is a Cloudflare Access destination. The
dashboard destinations are only `/auth/complete` and `/api/*`. Real pages verify
the signed `CF_Authorization` cookie after sign-in anchors on `/auth/complete`.

- The landing page owns no password, OAuth callback, or application login session.
- On hoverless/coarse-pointer devices, the landing entry keeps its text label visible at rest; touch users must not see the dot mark alone and mistake it for a loader.
- `/early-access` owns no identity session: the passcode is a product-admission credential, stored only as a Cloudflare secret, while Cloudflare Access remains the identity provider. Waitlist and unlock POSTs share the Worker's same-origin mutation guard and every early-access response is `no-store`.
- With `EARLY_ACCESS_GATE_ENABLED=true`, onboarding, home, settings, invitation, session, API, desktop-bootstrap, and WebSocket entry all require an active D1 grant. Disabling the flag restores pre-gate behavior without removing forms or data.
- `/onboarding`, `/home`, `/home/settings`, and the session lobby share the Archivo/shop-palette `shop-shell` visual system and wave field. Route-specific layout stays under `.onboarding-shell`, `.settings-shell`, or `.session-lobby-shell`; `/join` retains its established styling. `/floor` keeps its own `legacy-floor-*` layout and components, but resolves its tokens onto the same shop palette via a `.app-shell`-scoped block in `tokens.css` — see the Styling section below.
- `/home/settings?from=` is local navigation state, not authority: only `/home` or a current member-visible `/session/[id]` or `/session/[id]/floor` is accepted, and every invalid, stale, or non-member origin falls back to `/home` without revealing the session.
- Clicking Sign in anchors on the Access-protected `/auth/complete` path;
  Cloudflare Access performs the login and returns the browser to the requested
  page.
- `/signout` is the production sign-out endpoint (an application route, not Cloudflare's own `/cdn-cgi/access/logout` — see "Authentication and identity" for why).
- A join page reveals session title and owner only after authentication and only for a valid, active signed token.
- Opening a join URL does not change membership. The user must click Join.
- Creating a session requires a repository selected from the current user's active account installations and opens the normal lobby only after candidate provisioning is attempted. `repo=required` remains a focused recovery gate for legacy or failed-provision sessions; `setup=1` and `github=setup` are retired.
- Invite acceptance is idempotent because the session membership key is unique.
- Non-members opening a session or floor get a 404-style not-found response rather than session details.
- A member who leaves is disconnected from the room's presence object.
- An owner receives a conflict response if they try to leave.
- An owner can end the session instead. Ending is final in v1 (no un-end), idempotent, revokes the active invite in the same batch, and leaves all data readable. Collaboration, repository, preflight, run, and review mutations on an ended session return `409` with "This session has ended." — never `404`, which clients treat as "kicked from the session". Run cancellation remains available so already-running work can be stopped. Presence sockets stay open on ended sessions by design.
- Repository details are visible to session members, but only the owner can select, configure, disconnect, or reconnect from their account-authorized repositories.
- Repository preview controls and snapshot data are absent while `REPOSITORY_PREVIEW_ENABLED=false`. When enabled, only the owner may start, rebuild, or stop; every member HTTP or WebSocket proxy request is reauthorized and unauthorized/nonexistent hosts receive the same `404`. Candidate responses may be framed only by that environment's application origin, and the iframe receives no top-navigation permission.
- The GitHub installation callback is protected by Access, signed, expires after 30 minutes, is bound to the initiating user and purpose (`onboarding` or `settings`), and can be consumed once. Returned installation metadata is verified through the configured GitHub App before it is stored.
- The GitHub and Stripe webhook paths must remain outside Cloudflare Access so their providers can deliver events; raw-body signature verification is each route's authentication boundary.

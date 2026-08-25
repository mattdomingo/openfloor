# Cloudflare Access login-screen branding

The login screen users see before the app is the hosted Cloudflare Access page. It is external state: nothing in this repository renders or deploys it (see the AGENTS.md footgun list). These steps are applied by hand in the Cloudflare dashboard; nothing here ships with `wrangler deploy`.

The app-side companion is the `/` landing interstitial (`app/page.tsx`), which tells users the Cloudflare screen is coming.

## Steps

1. Cloudflare dashboard → Zero Trust → **Settings → Custom Pages** (field names drift between dashboard versions; look for the login-page / App Launcher branding section).
2. Custom logo: `https://app.opnflr.com/openfloor-mark.png` (already served from this repo's `public/`).
3. Colors, matched to the app's light theme tokens (the hosted page does not theme-switch):
   - Header: `#efe6d1` (`--surface-header`)
   - Background/footer: `#e3dac4` (`--surface-page`)
4. App Launcher: same logo. Confirm both Access applications' display names read "openfloor" — they appear on the login card. (Production runs the protected paths as two self-hosted applications sharing one policy, since Access caps a single application at five destinations and there are six protected paths — see `AGENTS.md`'s "Authentication and identity.") The app whose only destination is `app.opnflr.com/api/*` must have **Experience settings → "Show application in App Launcher"** turned off — its tile would otherwise be that literal, unroutable URL (2026-08-24 decision log).
5. Save, then verify in a private window via `https://app.opnflr.com/home` (should bounce to the branded Access screen).

## Caveats

- Keep Google + One-time PIN as the only identity providers. There is deliberately no app-owned login flow (decision log 2026-08-18; `app/access-auth.ts`).
- Sign-out is the app's own `/signout` (`app/signout/route.ts`), not `/cdn-cgi/access/logout` directly — see the 2026-08-24 decision log. `/signout` hands off to the team-domain logout, so the *final* screen the user lands on is still Cloudflare's hosted "logged out" page, and it inherits the same branding as the login screen above — nothing extra to configure for it.
- If the logo URL 404s, check the Worker's `app.opnflr.com` custom domain is serving `public/` assets before blaming the dashboard.

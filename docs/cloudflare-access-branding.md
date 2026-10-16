# Cloudflare Access login-screen branding

The login screen users see before the app is the hosted Cloudflare Access page. It is external state: nothing in this repository renders or deploys it (see the AGENTS.md footgun list). These steps are applied by hand in the Cloudflare dashboard; nothing here ships with `wrangler deploy`.

The app-side companion is the `/` landing interstitial (`app/page.tsx`), which tells users the Cloudflare screen is coming.

**This is now the fallback screen, not the primary one.** `/signin` (`app/signin/page.tsx`) is a custom-styled page matching the landing that most users see for the email/one-time-code path — it still authenticates through this same Access application, just with our own HTML in front of the email step. The Google identity provider is not proxied (see the 2026-08-25 decision log entry in `AGENTS.md`: the OAuth callback needs a cookie a server-side scrape can never deliver to the browser), so `/signin`'s Google link, and any failure of the custom page's upstream extraction, both land here — meaning this branded page is seen by every Google sign-in and is the safety net for the whole flow. Keep it current.

## What Cloudflare actually lets you control

Confirmed by reading the hosted Access page's markup and CSS, not assumed from the dashboard's field labels:

| Field | Controls | Notes |
| --- | --- | --- |
| Logo | Image beside the org name | Renders at `height:36px; width:auto`. `public/openfloor-mark.png` is transparent-background with near-black ink, so it sits cleanly on the background color below with no white box. |
| Organization name | Text next to the logo | Set to `openfloor`. |
| Background color | The page behind the card | **One color, not two.** `body,html{background:var(--page-bg-override)}` — there is no separate header-band color. |
| Header / footer | Text above/below the card | Plain text fields. |

Everything else about the card — its white background, text color, borders — is **locked** and cannot be themed, and **the card never goes dark**; it has no `prefers-color-scheme` handling. That's why the background below is the app's cream (`--surface-page`), not the landing page's black (`--entry-bg`, `app/styles/layout.css:9-17`): a locked white card on black would read as broken, not intentional, whereas cream-behind-white reproduces the same `--surface-raised`-on-`--surface-page` relationship every panel in the app already uses (`app/styles/components.css:1-6`).

Two fields are **not** Custom Pages settings, and are easy to miss because they show up on the same card:

- The `Log in to X` heading is each Access **application's** display name.
- The button label suffix (e.g. "Google ・ openfloor_google") is the **identity provider's** name in Zero Trust → Settings → Authentication.

## Steps

1. Cloudflare dashboard → Zero Trust → **Settings → Custom Pages → Access login page → Manage**.
2. Logo: `https://app.opnflr.com/openfloor-mark.png` (served from this repo's `public/`).
3. Organization name: `openfloor`.
4. Background color: `#e3dac4` (`--surface-page`). There is no second color field — do not look for a header-band color.
5. Header: `Choose how you want to sign in. You'll land back where you started.`
6. Footer: `openfloor — multiplayer development for agent teams`.
7. Access → Applications: rename **both** applications to `openfloor` — the heading reads whichever application's destination matched the request, and production splits the protected paths across two self-hosted applications sharing one policy (Access caps a single application at five destinations and there are six protected paths — see `AGENTS.md`'s "Authentication and identity"). The app whose only destination is `app.opnflr.com/api/*` must have **Experience settings → "Show application in App Launcher"** turned off — its tile would otherwise be that literal, unroutable URL (2026-08-24 decision log).
8. Access → Applications → **Experience settings** on both apps: confirm **Cookie Path Attribute is off**. On, it scopes `CF_Authorization` to the exact path that was visited, breaking cookie reuse across the app's other paths.
9. The three bare single-page destinations on App 1 (`/home`, `/settings`, `/onboarding`) need a **no-slash** trailing star in the Path field: type `home*`, `settings*`, `onboarding*` — **not** `home/*`. Next.js's client-side navigation requests `/home.rsc`, `/settings.rsc`, etc.; a destination without any star only matches the exact page and silently lets every soft-navigation request through unprotected ("leaving /settings or a session for /home signs you out," `CF_Authorization` unchanged throughout — 2026-08-25 root cause, see `AGENTS.md`'s "Authentication and identity"). But typing the slash form (`home/*`) is a *worse* regression, not a partial fix: that form only matches `/home/...` with a real trailing segment, so it drops coverage of the bare `/home` path too — Access stops protecting `/home` entirely and you get a full lockout, including a fresh sign-in from a private tab bouncing straight back to `/?auth=required`. `session/*` and `join/*` keep the slash form unchanged (every real request under them already has a mandatory id segment after the slash, so there's no bare path to lose), and so does App 2's `api/*` (API calls are plain `fetch()`s with explicit paths, never a `.rsc` soft-nav request).
10. Zero Trust → Settings → Authentication: rename the Google identity provider from `openfloor_google` to `Google` — that internal name is otherwise shown on the button itself.
11. Save, then verify in a private window via `https://app.opnflr.com/home` (should bounce to the branded Access screen), again via any `app.opnflr.com/api/*` path (the second application), and by signing in once and **clicking** (not reloading) between `/home`, `/settings`, and a session — no re-prompt should appear on any of those soft navigations.

## Caveats

- Keep Google + One-time PIN as the only identity providers. There is deliberately no app-owned login flow for Google (decision log 2026-08-18, revised 2026-08-25 for the email/one-time-code path only; `app/access-auth.ts`).
- Sign-out is the app's own `/signout` (`app/signout/route.ts`), not `/cdn-cgi/access/logout` directly — see the 2026-08-24 decision log. `/signout` ends the team-domain session with a background `no-cors` request rather than navigating there, so the user's *final* screen is the app's own landing page (`/`), not Cloudflare's hosted "logged out" page — the branding above only covers the login screen now.
- If the logo URL 404s, check the Worker's `app.opnflr.com` custom domain is serving `public/` assets before blaming the dashboard. If the logo appears to do nothing, note Cloudflare's own CSS hides the slot entirely when the src is empty (`.OrgAvatarLink-logo:has(img[src=""]){display:none}`) — a blank field silently produces no logo rather than a broken image.

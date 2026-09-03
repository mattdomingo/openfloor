# Cloudflare Access login-screen branding

The hosted Cloudflare Access page is fallback UI and external dashboard state;
`wrangler deploy` does not configure it. Most users first see openfloor's owned
`/signin` page, which still delegates authentication to the same Access
application. GitHub follows a direct browser navigation into Access, and any
failure to parse Cloudflare's One-time PIN form also falls back to the hosted
screen.

## What Cloudflare lets you control

| Field | Controls | Notes |
| --- | --- | --- |
| Logo | Image beside the organization name | Use the transparent `public/openfloor-mark.png`. |
| Organization name | Text beside the logo | Set to `openfloor`. |
| Background color | Page behind the card | Use `#e3dac4`; the card itself stays white. |
| Header/footer | Text above and below the card | Plain text only. |

The Access application's display name controls the hosted `Log in to …` heading,
and identity-provider names control the provider button labels.

## Steps

1. Zero Trust → Settings → Custom Pages → Access login page → Manage.
2. Logo: `https://app.opnflr.com/openfloor-mark.png`.
3. Organization name: `openfloor`.
4. Background color: `#e3dac4`.
5. Header: `Choose how you want to sign in. You'll land back where you started.`
6. Footer: `openfloor — multiplayer development for agent teams`.
7. Access → Applications → `openfloor`: verify the destinations are exactly
   `app.opnflr.com/api/*` and `app.opnflr.com/auth/complete`.
8. Keep Cookie Path Attribute off; the cookie minted at `/auth/complete` must be
   sent to real pages outside that Access path.
9. Hide the application from the App Launcher unless its launcher target is set
   explicitly to a real page such as `https://app.opnflr.com/`; `/api/*` is not
   a usable browser entry point.
10. Keep GitHub and One-time PIN as the intended production identity providers.
11. Verify in a private window: opening `/home` should reach openfloor's owned
    sign-in flow, authentication should pass through `/auth/complete`, subsequent
    navigation between `/home`, `/settings`, and a session should not re-prompt,
    and an unauthenticated `/api/*` request should receive an Access challenge.

## Caveats

- Sign out through `/signout`, not `/cdn-cgi/access/logout` directly. The owned
  route ends both application- and team-domain sessions and returns to `/`.
- `/signout`, `/signin*`, real pages, webhooks, and runtime routes must remain
  outside the Access application's destinations.
- Zero Trust's Require Access Protection setting must remain off; otherwise all
  unmatched page and service paths are blocked before the Worker can apply their
  own authentication.
- If the logo does not render, first verify that the Worker custom domain serves
  the public asset URL.

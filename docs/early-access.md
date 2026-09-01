# Early Access Operations

The application-level early-access gate is independent from Cloudflare Access. Cloudflare Access still authenticates identity; D1 decides whether that authenticated account may use openfloor. The public waitlist is also D1-authoritative. Google Sheets is an operations mirror and can never grant application access.

## Production model

- `EARLY_ACCESS_GATE_ENABLED=false` leaves every existing page, API, desktop bootstrap, invitation, onboarding flow, and WebSocket behavior unchanged. The public forms, D1 writes, Sheet delivery, and operator commands still work.
- With the flag `true`, a user needs `users.early_access_granted_at` and no `early_access_revoked_at`. Existing non-deleted accounts were backfilled by migration `0044`; new accounts begin unadmitted.
- A correct shared passcode grants an authenticated account. Before authentication it creates a signed, HTTP-only, SameSite=Lax cookie that expires after 15 minutes; `/early-access/complete` consumes it after Cloudflare authentication.
- Revocation is sticky. The shared passcode cannot clear `early_access_revoked_at`; only the `grant` operator command restores the account.
- Waitlist records expire 12 months after their last D1 update. The daily Worker cron removes a bounded batch, and the Sheet's daily Apps Script trigger independently removes expired mirrored rows.
- The passcode is compared in constant time and is never stored or logged. It is never sent to Google.

## Create the company Sheet

1. In the company Shared Drive, create `Growth / Early Access`.
2. Create the spreadsheet `openfloor Early Access Waitlist` in that folder.
3. Rename the first tab `Waitlist` and set row 1 exactly to:

   `Record ID | Submitted At | Updated At | Name | Email | Status`

4. Open Extensions → Apps Script and replace the bound script with [`scripts/google-apps-script/early-access-waitlist.gs`](../scripts/google-apps-script/early-access-waitlist.gs).
5. Generate a webhook secret locally:

   ```bash
   openssl rand -hex 32
   ```

6. In Apps Script, open Project Settings → Script Properties and add `WAITLIST_SHEET_WEBHOOK_SECRET` with that value.
7. Deploy → New deployment → Web app. Execute as the company account and allow access to **Anyone**. The endpoint is intentionally public at the network layer because Apps Script cannot accept a Cloudflare service binding; every request is instead protected by a timestamped HMAC and rejected after five minutes. Copy the `/exec` URL.
8. In Apps Script, create a time-driven daily trigger for `purgeExpiredWaitlistRows`.

The script holds a lock, finds rows by Record ID, and updates or appends idempotently. Editing or deleting Sheet rows does not change D1 and never changes admission.

## Set Cloudflare secrets

Set the Sheet URL and the exact matching secret:

```bash
npx wrangler secret put WAITLIST_SHEET_WEBHOOK_URL
npx wrangler secret put WAITLIST_SHEET_WEBHOOK_SECRET
```

Generate a separate, shareable beta passcode with a password manager or `openssl rand -base64 24`, then set it without putting the value in shell history:

```bash
npx wrangler secret put EARLY_ACCESS_PASSWORD
```

Rotation affects only future passcode checks and any unconsumed 15-minute admission cookie. Existing account grants remain valid.

## Configure WAF rate limits

In Cloudflare Security → WAF → Rate limiting rules for `app.opnflr.com`, create both rules before enabling enforcement:

1. `POST /early-access/unlock`: count by source IP, 10 requests per 10 minutes, block for 1 hour.
2. `POST /early-access/waitlist`: count by source IP, 5 requests per 10 minutes, block for 10 minutes.

Scope both to method `POST`, exact hostname `app.opnflr.com`, and the exact path. Do not include `/early-access/complete`; it consumes a signed cookie and does not accept a passcode.

Do not change Cloudflare Access applications, destinations, identity providers, or policies. In particular, do not add `/early-access*` to Access. The existing `/auth/complete` protected entry mints the Access session and returns to the public completion route. If the upstream Access policy restricts eligible email addresses, an admitted user must still satisfy that policy; application admission cannot override an Access denial.

## Operate access and Sheet delivery

Commands default to local D1 unless `--remote` is explicit:

```bash
npm run early-access -- list --remote
npm run early-access -- grant person@example.com --remote
npm run early-access -- revoke person@example.com --remote
npm run early-access -- resync person@example.com --remote
```

- `grant` and `revoke` refuse unless a non-deleted authenticated account already exists. If no account exists, send the shared passcode instead.
- `grant` clears a prior revocation, records source `manual`, and queues any matching waitlist row for Sheet sync.
- `revoke` takes effect on the next page/API request and closes an existing session WebSocket on the presence alarm, within 15 minutes.
- `resync` only marks a waitlist record pending. The 10-minute Worker cron retries up to 25 pending records per run with bounded exponential backoff.
- Sheet delivery errors are stored in `early_access_waitlist.sheet_last_error`; the original D1 write remains successful.

## Rollout and rollback

1. Deploy migration and code with the committed `EARLY_ACCESS_GATE_ENABLED=false` value. Configure the Sheet, three secrets, and two WAF rules. Submit both a new and duplicate waitlist entry; confirm one D1 row and one Sheet row update. Exercise an operator resync.
2. Change the versioned production flag to `true`, run the full release pipeline, and test an existing backfilled account, an incognito visitor, invalid and valid passcodes, onboarding, an invitation deep link, desktop bootstrap, and a returning admitted account.

Rollback is changing `EARLY_ACCESS_GATE_ENABLED` back to `false` and redeploying. Waitlist data, grants, and revocations remain intact and can continue syncing while enforcement is off.

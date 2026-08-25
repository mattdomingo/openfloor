# Stripe billing

openfloor uses Stripe Checkout for new Pro and Max subscriptions, Stripe Customer Portal for billing management and confirmed plan/seat changes, and signed webhooks to project subscription state into D1 entitlements.

## Product and price setup

Create two recurring licensed prices in Stripe:

- Pro: USD $30 per seat per month. Allowed quantity: 3–5.
- Max: USD $50 per seat per month. Allowed quantity: 3–10.

Use monthly recurring prices with `usage_type=licensed`. Do not use metered, yearly, tiered, or tax-inclusive prices for these IDs. openfloor retrieves each configured price before Checkout or a plan change and refuses it unless currency, amount, recurrence, and usage type match `lib/plans.ts`.

Create a Customer Portal configuration with:

- subscription cancellation enabled and effective immediately;
- subscription updates enabled only for the configured Pro and Max prices;
- quantity updates enabled;
- prorations enabled and applied immediately;
- no trial, yearly, or unrelated product switching.

The configuration is an external Stripe invariant. `STRIPE_PORTAL_CONFIGURATION_ID` must identify this exact configuration; a permissive default Portal configuration can bypass openfloor's plan/quantity choices.

## Webhook

Create a Stripe webhook endpoint at:

```text
https://app.opnflr.com/webhooks/stripe
```

Subscribe it to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `invoice.paid`
- `invoice.payment_failed`

The route is intentionally outside Cloudflare Access. Its boundary is a 256 KB body cap plus Stripe's raw-body signature. Keep the webhook signing secret separate from the API secret key.

## Cloudflare configuration

Set secrets:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PRO_PRICE_ID
npx wrangler secret put STRIPE_MAX_PRICE_ID
npx wrangler secret put STRIPE_PORTAL_CONFIGURATION_ID
```

Apply D1 migrations before deploying code. Leave `STRIPE_CHECKOUT_ENABLED` set to `false` in `wrangler.jsonc` until prices, Portal configuration, webhook, secrets, migrations, and the deployed Worker are all ready. Then change it to `true`, merge, and let the normal production pipeline deploy it.

## Acceptance

Use Stripe test mode first:

1. Sign in as a new direct user, complete the profile, select Free, and confirm `/home` opens with Free limits.
2. Sign in as another new user, select Pro and 4 seats, complete Checkout, and confirm return from Stripe reaches `/home` only after the account becomes active.
3. Confirm `/settings?section=plan` shows Pro, 4 seats per session, and the current billing period.
4. Create a session and verify its fourth member can join while a fifth additional member is refused.
5. Change to Max with 6 seats. Confirm Stripe shows an immediate prorated change and openfloor updates to Max/6 after the webhook.
6. Cancel through Portal. Confirm cancellation is immediate and openfloor falls back to Free limits.
7. Repeat paid signup from a valid invite URL. The invite path must skip plan selection and grant Free; upgrading remains available afterward in Settings.
8. Send an invalid-signature webhook and confirm `401`. Replay a valid event and confirm it is acknowledged without applying twice.
9. Delete a paid test account. Confirm Stripe subscription cancellation happens immediately with no refund and the account is deleted only after cancellation succeeds.

## Ownership and failure behavior

- Stripe customer and subscription metadata bind purchases to the internal openfloor user ID, never payment email. Checkout therefore cannot sell to a person who has no openfloor row: paid signup begins only after authentication and profile submission.
- Stripe is authoritative for subscription lifecycle. D1 stores customers, subscription snapshots, webhook delivery state, and the entitlement projection used by the product.
- Active/trialing Pro or Max grants its exact purchased quantity. Past-due, unpaid, paused, canceled, incomplete, and unsupported-price states fail closed to Free limits.
- Unknown prices or invalid quantities return `500` from the webhook so Stripe retries; they never grant access.
- Event IDs deduplicate deliveries and Stripe event creation time prevents an older subscription event from rolling back a newer snapshot.
- Existing active Enterprise entitlements override self-serve Stripe. Existing manual active Pro/Max rows with no `seat_limit` keep their historical 5/10-seat cap.
- Account deletion first checks repository blockers, cancels every known non-terminal Stripe subscription immediately without refund, rechecks blockers, then scrubs the account. Stripe failure leaves the account intact. A repository race after cancellation can leave the account intact but unsubscribed; the user may retry deletion.

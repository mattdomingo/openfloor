-- One-off manual grant: give internal test accounts the "enterprise" plan
-- (unlimited seats/hours per PLAN_LIMITS in lib/plans.ts). This is the same
-- sales-managed override mechanism db/billing.ts already protects from being
-- clobbered by Stripe webhook activity (see projectStripeEntitlement).
--
-- Confirm these are the exact, normalized (lowercase, trimmed) addresses
-- before running — email is the unique identity key (idx_users_email).
UPDATE users
SET plan = 'enterprise',
    plan_status = 'active',
    updated_at = unixepoch() * 1000
WHERE email IN ('matt@opnflr.com', 'ali@opnflr.com', 'ryan@opnflr.com')
  AND deleted_at IS NULL;

// Pure plan/entitlement model — deliberately free of any cloudflare:workers
// import (unlike db/sessions.ts, which pulls in the D1 binding types) so it
// is reachable from tests/unit under plain node.

export type Plan = "free" | "pro" | "max" | "enterprise";
export type PaidPlan = "pro" | "max";
export type PlanStatus = "inactive" | "active" | "past_due" | "canceled";

// The whole entitlement model: seats cap session_members rows, hours cap
// monthly active-presence time, both keyed to the session owner's
// *effective* plan (see effectivePlan below) — the purchased plan only
// grants its limits while plan_status is "active".
export const PLAN_LIMITS: Record<Plan, { seats: number; hours: number }> = {
  free: { seats: 3, hours: 2 },
  pro: { seats: 5, hours: 30 },
  max: { seats: 10, hours: 100 },
  enterprise: { seats: Infinity, hours: Infinity },
};

export const PAID_PLAN_CATALOG: Record<PaidPlan, {
  unitAmountCents: number;
  currency: "usd";
  minimumSeats: number;
  maximumSeats: number;
}> = {
  pro: { unitAmountCents: 3_000, currency: "usd", minimumSeats: 3, maximumSeats: 5 },
  max: { unitAmountCents: 5_000, currency: "usd", minimumSeats: 3, maximumSeats: 10 },
};

// Internal @opnflr.com accounts always test at enterprise's unlimited
// seats/hours, independent of the row's stored plan/plan_status — this is
// the one seam every limit check already passes through (effectivePlan /
// effectiveSeatLimit), so no quota call site needs its own bypass. Email is
// matched case-insensitively even though upsertUser only ever stores
// normalizeEmail's lowercase output, since this is a security-relevant
// default worth not depending on that invariant.
const UNLIMITED_TESTING_EMAIL_SUFFIX = "@opnflr.com";

function isUnlimitedTestingEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(UNLIMITED_TESTING_EMAIL_SUFFIX);
}

// A purchased plan only grants its limits while status is "active";
// inactive (never purchased), past_due, and canceled all fall back to free
// rather than locking the owner out entirely. `email` is optional so every
// existing call site keeps compiling; omitting it just means that call site
// doesn't get the @opnflr.com override.
export function effectivePlan(plan: Plan, status: PlanStatus, email?: string | null): Plan {
  if (isUnlimitedTestingEmail(email)) return "enterprise";
  return status === "active" ? plan : "free";
}

// Stripe-managed Pro/Max accounts store their purchased per-session seat
// quantity. Legacy/manual grants have no quantity and retain the historical
// tier cap. Free and lapsed accounts always get Free's three seats.
export function effectiveSeatLimit(
  plan: Plan,
  status: PlanStatus,
  purchasedSeats: number | null,
  email?: string | null,
): number {
  const effective = effectivePlan(plan, status, email);
  if (effective === "free" || effective === "enterprise") return PLAN_LIMITS[effective].seats;
  const catalog = PAID_PLAN_CATALOG[effective];
  return purchasedSeats != null
    && Number.isInteger(purchasedSeats)
    && purchasedSeats >= catalog.minimumSeats
    && purchasedSeats <= catalog.maximumSeats
    ? purchasedSeats
    : PLAN_LIMITS[effective].seats;
}

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "pro" || value === "max";
}

export function validPaidSeatQuantity(plan: PaidPlan, value: unknown): value is number {
  const limits = PAID_PLAN_CATALOG[plan];
  return typeof value === "number" && Number.isInteger(value)
    && value >= limits.minimumSeats && value <= limits.maximumSeats;
}

export function currentMonth(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 7); // UTC "YYYY-MM"
}

const PLAN_LABELS: Record<Plan, string> = { free: "Free", pro: "Pro", max: "Max", enterprise: "Enterprise" };

export function planLabel(plan: Plan): string {
  return PLAN_LABELS[plan];
}

// The seats/hours sentence used wherever a plan's limits are spelled out in
// full (currently just the settings Plan section) — the Infinity branches
// match PLAN_LIMITS.enterprise.
export function planLimitsSummary(plan: Plan): string {
  const limits = PLAN_LIMITS[plan];
  const seats = Number.isFinite(limits.seats) ? `${limits.seats} seats per session` : "unlimited seats per session";
  const hours = Number.isFinite(limits.hours) ? `${limits.hours}h of session time per month` : "unlimited session time";
  return `${seats}, ${hours}`;
}

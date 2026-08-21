// Pure plan/entitlement model — deliberately free of any cloudflare:workers
// import (unlike db/sessions.ts, which pulls in the D1 binding types) so it
// is reachable from tests/unit under plain node.

export type Plan = "free" | "pro" | "max" | "enterprise";
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

// A purchased plan only grants its limits while status is "active";
// inactive (never purchased), past_due, and canceled all fall back to free
// rather than locking the owner out entirely.
export function effectivePlan(plan: Plan, status: PlanStatus): Plan {
  return status === "active" ? plan : "free";
}

export function currentMonth(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 7); // UTC "YYYY-MM"
}

// Stripe payment link. Paying here does not automatically grant an
// entitlement — see the "Grant a plan after purchase" runbook in
// README.md. One link can only sell one tier; a second product (e.g. Max)
// needs a second link and a way to tell them apart at grant time.
export const UPGRADE_URL = "https://buy.stripe.com/fZudR93OAaWMehu35t4F200";

const PLAN_LABELS: Record<Plan, string> = { free: "Free", pro: "Pro", max: "Max", enterprise: "Enterprise" };

export function planLabel(plan: Plan): string {
  return PLAN_LABELS[plan];
}

import { getDb, type D1DatabaseLike } from "./index";
import { PAID_PLAN_CATALOG, type PaidPlan, type Plan, type PlanStatus } from "@/lib/plans";

export type StripeSubscriptionSnapshot = {
  id: string;
  userId: string;
  customerId: string;
  priceId: string;
  plan: PaidPlan | null;
  quantity: number;
  status: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  eventCreated: number;
};

export type BillingSummary = {
  customerId: string | null;
  subscriptionId: string | null;
  plan: PaidPlan | null;
  quantity: number | null;
  stripeStatus: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
};

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const PAST_DUE_STATUSES = new Set(["past_due", "unpaid", "paused"]);
const TERMINAL_STATUSES = new Set(["canceled", "incomplete_expired"]);

function validSnapshot(snapshot: StripeSubscriptionSnapshot): boolean {
  if (!snapshot.plan) return false;
  const catalog = PAID_PLAN_CATALOG[snapshot.plan];
  return Number.isInteger(snapshot.quantity)
    && snapshot.quantity >= catalog.minimumSeats
    && snapshot.quantity <= catalog.maximumSeats;
}

export async function getStripeCustomerId(userId: string, database = getDb()): Promise<string | null> {
  const row = await database.prepare("SELECT stripe_customer_id AS customerId FROM stripe_customers WHERE user_id = ?")
    .bind(userId).first<{ customerId: string }>();
  return row?.customerId ?? null;
}

export async function saveStripeCustomer(userId: string, customerId: string, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `INSERT INTO stripe_customers (user_id, stripe_customer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, updated_at = excluded.updated_at`,
  ).bind(userId, customerId, now, now).run();
}

export async function getUserIdForStripeCustomer(customerId: string, database = getDb()): Promise<string | null> {
  const row = await database.prepare("SELECT user_id AS userId FROM stripe_customers WHERE stripe_customer_id = ?")
    .bind(customerId).first<{ userId: string }>();
  return row?.userId ?? null;
}

export async function claimStripeWebhookEvent(eventId: string, eventType: string, database = getDb()): Promise<"new" | "retry" | "processed"> {
  const existing = await database.prepare(
    "SELECT processing_status AS status FROM stripe_webhook_events WHERE stripe_event_id = ?",
  ).bind(eventId).first<{ status: "processing" | "processed" | "failed" }>();
  if (existing?.status === "processed") return "processed";
  if (existing) {
    await database.prepare(
      "UPDATE stripe_webhook_events SET processing_status = 'processing', error = NULL WHERE stripe_event_id = ?",
    ).bind(eventId).run();
    return "retry";
  }
  await database.prepare(
    `INSERT INTO stripe_webhook_events (stripe_event_id, event_type, processing_status, received_at)
     VALUES (?, ?, 'processing', ?)`,
  ).bind(eventId, eventType, Date.now()).run();
  return "new";
}

export async function finishStripeWebhookEvent(eventId: string, error: string | null, database = getDb()): Promise<void> {
  await database.prepare(
    `UPDATE stripe_webhook_events SET processing_status = ?, error = ?, processed_at = ? WHERE stripe_event_id = ?`,
  ).bind(error ? "failed" : "processed", error, Date.now(), eventId).run();
}

export async function saveStripeSubscription(snapshot: StripeSubscriptionSnapshot, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `INSERT INTO stripe_subscriptions
       (stripe_subscription_id, user_id, stripe_customer_id, stripe_price_id, plan, quantity, status,
        current_period_end, cancel_at_period_end, event_created, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stripe_subscription_id) DO UPDATE SET
       user_id = excluded.user_id,
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_price_id = excluded.stripe_price_id,
       plan = excluded.plan,
       quantity = excluded.quantity,
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       event_created = excluded.event_created,
       updated_at = excluded.updated_at
     WHERE excluded.event_created >= stripe_subscriptions.event_created`,
  ).bind(
    snapshot.id, snapshot.userId, snapshot.customerId, snapshot.priceId, snapshot.plan, snapshot.quantity,
    snapshot.status, snapshot.currentPeriodEnd, snapshot.cancelAtPeriodEnd ? 1 : 0, snapshot.eventCreated, now, now,
  ).run();
  await projectStripeEntitlement(snapshot.userId, database);
}

async function projectStripeEntitlement(userId: string, database: D1DatabaseLike): Promise<void> {
  const user = await database.prepare("SELECT plan, plan_status AS planStatus, deleted_at AS deletedAt FROM users WHERE id = ?")
    .bind(userId).first<{ plan: Plan; planStatus: PlanStatus; deletedAt: number | null }>();
  if (!user || user.deletedAt != null) return;
  // Manual Enterprise is a sales-managed override. Stripe Pro/Max activity
  // must never silently downgrade it.
  if (user.plan === "enterprise" && user.planStatus === "active") return;

  const rows = await database.prepare(
    `SELECT plan, quantity, status FROM stripe_subscriptions WHERE user_id = ?`,
  ).bind(userId).all<{ plan: PaidPlan | null; quantity: number; status: string }>();
  const valid = rows.results.filter((row) => validSnapshot({
    id: "", userId, customerId: "", priceId: "", plan: row.plan, quantity: row.quantity,
    status: row.status, currentPeriodEnd: null, cancelAtPeriodEnd: false, eventCreated: 0,
  }));
  const active = valid.filter((row) => ACTIVE_STATUSES.has(row.status));
  const pastDue = valid.filter((row) => PAST_DUE_STATUSES.has(row.status));
  const chosen = active.length > 0 ? active : pastDue;
  const plan = chosen.some((row) => row.plan === "max") ? "max" : chosen.some((row) => row.plan === "pro") ? "pro" : user.plan;
  const seatLimit = chosen.length > 0 ? Math.max(...chosen.map((row) => row.quantity)) : null;
  const status: PlanStatus = active.length > 0
    ? "active"
    : pastDue.length > 0
      ? "past_due"
      : valid.some((row) => TERMINAL_STATUSES.has(row.status))
        ? "canceled"
        : "inactive";
  await database.prepare(
    "UPDATE users SET plan = ?, plan_status = ?, seat_limit = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
  ).bind(plan, status, seatLimit, Date.now(), userId).run();
}

export async function getBillingSummary(userId: string, database = getDb()): Promise<BillingSummary> {
  const customerId = await getStripeCustomerId(userId, database);
  const rows = await database.prepare(
    `SELECT stripe_subscription_id AS subscriptionId, plan, quantity, status,
            current_period_end AS currentPeriodEnd, cancel_at_period_end AS cancelAtPeriodEnd
     FROM stripe_subscriptions WHERE user_id = ? ORDER BY updated_at DESC`,
  ).bind(userId).all<{
    subscriptionId: string; plan: PaidPlan | null; quantity: number; status: string;
    currentPeriodEnd: number | null; cancelAtPeriodEnd: number;
  }>();
  const preferred = rows.results.find((row) => ACTIVE_STATUSES.has(row.status))
    ?? rows.results.find((row) => PAST_DUE_STATUSES.has(row.status))
    ?? rows.results[0];
  return {
    customerId,
    subscriptionId: preferred?.subscriptionId ?? null,
    plan: preferred?.plan ?? null,
    quantity: preferred?.quantity ?? null,
    stripeStatus: preferred?.status ?? null,
    currentPeriodEnd: preferred?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: Boolean(preferred?.cancelAtPeriodEnd),
  };
}

export async function listNonTerminalStripeSubscriptionIds(userId: string, database = getDb()): Promise<string[]> {
  const rows = await database.prepare(
    `SELECT stripe_subscription_id AS id FROM stripe_subscriptions
     WHERE user_id = ? AND status NOT IN ('canceled', 'incomplete_expired')`,
  ).bind(userId).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

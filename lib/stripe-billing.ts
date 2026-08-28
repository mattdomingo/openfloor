import type Stripe from "stripe";
import {
  getBillingSummary,
  getStripeCustomerId,
  getUserIdForStripeCustomer,
  listNonTerminalStripeSubscriptionIds,
  markStripeSubscriptionTerminal,
  saveStripeCustomer,
  saveStripeSubscription,
  type BillingSummary,
  type StripeSubscriptionSnapshot,
} from "@/db/billing";
import { findUserById, markOnboardingComplete } from "@/db/sessions";
import { BASE_PATH } from "@/components/basePath";
import { PAID_PLAN_CATALOG, type PaidPlan, validPaidSeatQuantity } from "./plans";
import type { AppUser } from "./session-types";
import { BillingConfigurationError, getStripeBillingConfig, getStripeClient } from "./stripe";

const USER_METADATA_KEY = "openfloor_user_id";

export { BillingConfigurationError };
export class BillingConflictError extends Error {}

function configuredPriceId(plan: PaidPlan): string {
  const id = getStripeBillingConfig().priceIds[plan];
  if (!id) throw new BillingConfigurationError(`Stripe ${plan} price is unavailable.`);
  return id;
}

function pricePlan(priceId: string): PaidPlan | null {
  const prices = getStripeBillingConfig().priceIds;
  return priceId === prices.pro ? "pro" : priceId === prices.max ? "max" : null;
}

async function verifyConfiguredPrice(plan: PaidPlan): Promise<string> {
  const priceId = configuredPriceId(plan);
  const price = await getStripeClient().prices.retrieve(priceId);
  const expected = PAID_PLAN_CATALOG[plan];
  if (!price.active
    || price.currency !== expected.currency
    || price.unit_amount !== expected.unitAmountCents
    || price.recurring?.interval !== "month"
    || price.recurring.usage_type !== "licensed") {
    throw new BillingConfigurationError(`Stripe ${plan} price does not match openfloor billing terms.`);
  }
  return priceId;
}

async function ensureStripeCustomer(user: AppUser): Promise<string> {
  const existing = await getStripeCustomerId(user.id);
  const stripe = getStripeClient();
  if (existing) {
    await stripe.customers.update(existing, {
      email: user.email,
      name: user.displayName,
      metadata: { [USER_METADATA_KEY]: user.id },
    });
    return existing;
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.displayName,
    metadata: { [USER_METADATA_KEY]: user.id },
  }, { idempotencyKey: `openfloor-customer-${user.id}` });
  await saveStripeCustomer(user.id, customer.id);
  return customer.id;
}

function appUrl(requestUrl: string, path: string): string {
  const mountedPath = BASE_PATH && (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`))
    ? path
    : `${BASE_PATH}${path}`;
  return new URL(mountedPath, new URL(requestUrl).origin).toString();
}

export async function createStripeCheckout(
  user: AppUser,
  input: { plan: PaidPlan; quantity: number; requestUrl: string; returnTo: string; cancelTo: string },
): Promise<string> {
  const config = getStripeBillingConfig();
  if (!config.checkoutEnabled) throw new BillingConfigurationError("Paid checkout is temporarily unavailable.");
  if (!validPaidSeatQuantity(input.plan, input.quantity)) throw new BillingConflictError("Invalid paid seat quantity.");
  if (user.plan === "enterprise" && user.planStatus === "active") {
    throw new BillingConflictError("Enterprise billing is managed through openfloor sales.");
  }
  const current = await getBillingSummary(user.id);
  if (current.subscriptionId && current.stripeStatus && !["canceled", "incomplete_expired"].includes(current.stripeStatus)) {
    throw new BillingConflictError("This account already has a Stripe subscription.");
  }
  const priceId = await verifyConfiguredPrice(input.plan);
  const customerId = await ensureStripeCustomer(user);
  const bounds = PAID_PLAN_CATALOG[input.plan];
  const success = appUrl(input.requestUrl, "/api/billing/checkout/return");
  const session = await getStripeClient().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{
      price: priceId,
      quantity: input.quantity,
      adjustable_quantity: { enabled: true, minimum: bounds.minimumSeats, maximum: bounds.maximumSeats },
    }],
    subscription_data: { metadata: { [USER_METADATA_KEY]: user.id } },
    success_url: `${success}?session_id={CHECKOUT_SESSION_ID}&return_to=${encodeURIComponent(input.returnTo)}`,
    cancel_url: appUrl(input.requestUrl, input.cancelTo),
  });
  if (!session.url) throw new Error("Stripe Checkout did not return a redirect URL.");
  return session.url;
}

function subscriptionCustomerId(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
}

function subscriptionSnapshot(subscription: Stripe.Subscription, userId: string, eventCreated = Math.floor(Date.now() / 1_000)): StripeSubscriptionSnapshot {
  const item = subscription.items.data[0];
  if (!item || typeof item.price?.id !== "string") throw new Error("Stripe subscription has no priced item.");
  return {
    id: subscription.id,
    userId,
    customerId: subscriptionCustomerId(subscription),
    priceId: item.price.id,
    plan: pricePlan(item.price.id),
    quantity: item.quantity ?? 0,
    status: subscription.status,
    currentPeriodEnd: item.current_period_end ? item.current_period_end * 1_000 : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    eventCreated,
  };
}

export async function reconcileStripeSubscription(subscription: Stripe.Subscription, expectedUserId?: string, eventCreated?: number): Promise<void> {
  const customerId = subscriptionCustomerId(subscription);
  const metadataUserId = subscription.metadata[USER_METADATA_KEY]?.trim() || null;
  const mappedUserId = await getUserIdForStripeCustomer(customerId);
  const userId = metadataUserId ?? mappedUserId;
  if (!userId || (expectedUserId && userId !== expectedUserId) || (mappedUserId && mappedUserId !== userId)) {
    throw new Error("Stripe subscription is not bound to the expected openfloor account.");
  }
  const user = await findUserById(userId);
  if (!user) throw new Error("Stripe subscription targets a missing openfloor account.");
  await saveStripeCustomer(userId, customerId);
  const snapshot = subscriptionSnapshot(subscription, userId, eventCreated);
  await saveStripeSubscription(snapshot);
  // Account deletion cancels synchronously, then tombstones the user. Stripe
  // may deliver that cancellation again afterward; acknowledge terminal state
  // instead of forcing retries forever. Any non-terminal subscription against
  // a deleted account remains an error because billing is still live.
  if (user.deletedAt != null) {
    if (["canceled", "incomplete_expired"].includes(subscription.status)) return;
    throw new Error("A deleted openfloor account still has a non-terminal Stripe subscription.");
  }
  if (!snapshot.plan || !validPaidSeatQuantity(snapshot.plan, snapshot.quantity)) {
    throw new BillingConfigurationError("Stripe subscription uses an unsupported price or seat quantity.");
  }
  if (subscription.status === "active" || subscription.status === "trialing") {
    await markOnboardingComplete(userId);
  }
}

export async function reconcileStripeCheckout(sessionId: string, expectedUserId: string): Promise<void> {
  const session = await getStripeClient().checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
  if (session.client_reference_id !== expectedUserId || session.payment_status === "unpaid") {
    throw new BillingConflictError("Stripe Checkout is not complete for this account.");
  }
  if (!session.subscription || typeof session.subscription === "string") {
    throw new Error("Stripe Checkout has no subscription to reconcile.");
  }
  await reconcileStripeSubscription(session.subscription, expectedUserId);
}

export async function reconcileStripeEventObject(object: Stripe.Event.Data.Object, eventCreated?: number): Promise<void> {
  const objectType = (object as { object?: string }).object;
  if (objectType === "subscription") {
    await reconcileStripeSubscription(object as Stripe.Subscription, undefined, eventCreated);
    return;
  }
  if (objectType === "checkout.session") {
    const session = object as Stripe.Checkout.Session;
    if (typeof session.subscription === "string") {
      await reconcileStripeSubscription(await getStripeClient().subscriptions.retrieve(session.subscription));
    } else if (session.subscription) {
      await reconcileStripeSubscription(session.subscription as Stripe.Subscription);
    }
    return;
  }
  if (objectType === "invoice") {
    const invoice = object as Stripe.Invoice;
    const subscription = invoice.parent?.subscription_details?.subscription;
    const id = typeof subscription === "string" ? subscription : subscription?.id;
    if (id) await reconcileStripeSubscription(await getStripeClient().subscriptions.retrieve(id));
  }
}

export async function createStripePortal(user: AppUser, requestUrl: string, returnTo: string): Promise<string> {
  const config = getStripeBillingConfig();
  if (!config.portalConfigurationId) throw new BillingConfigurationError("Stripe Customer Portal is unavailable.");
  const customer = await ensureStripeCustomer(user);
  return (await getStripeClient().billingPortal.sessions.create({
    customer,
    configuration: config.portalConfigurationId,
    return_url: appUrl(requestUrl, returnTo),
  })).url;
}

export async function createStripePlanChange(
  user: AppUser,
  input: { plan: PaidPlan; quantity: number; requestUrl: string; returnTo: string },
): Promise<string> {
  const config = getStripeBillingConfig();
  if (!config.checkoutEnabled || !config.portalConfigurationId) throw new BillingConfigurationError("Stripe plan changes are unavailable.");
  if (!validPaidSeatQuantity(input.plan, input.quantity)) throw new BillingConflictError("Invalid paid seat quantity.");
  const summary = await getBillingSummary(user.id);
  if (!summary.subscriptionId) throw new BillingConflictError("No Stripe subscription is available to change.");
  const subscription = await getStripeClient().subscriptions.retrieve(summary.subscriptionId);
  const item = subscription.items.data[0];
  if (!item) throw new Error("Stripe subscription has no item to change.");
  const price = await verifyConfiguredPrice(input.plan);
  const customer = await ensureStripeCustomer(user);
  return (await getStripeClient().billingPortal.sessions.create({
    customer,
    configuration: config.portalConfigurationId,
    return_url: appUrl(input.requestUrl, input.returnTo),
    flow_data: {
      type: "subscription_update_confirm",
      subscription_update_confirm: {
        subscription: subscription.id,
        items: [{ id: item.id, price, quantity: input.quantity }],
      },
      after_completion: { type: "redirect", redirect: { return_url: appUrl(input.requestUrl, input.returnTo) } },
    },
  })).url;
}

const TERMINAL_STRIPE_STATUSES = new Set(["canceled", "incomplete_expired"]);

function terminalStripeStatus(status: string): "canceled" | "incomplete_expired" {
  return status === "incomplete_expired" ? "incomplete_expired" : "canceled";
}

// Stripe's "that id doesn't exist" shape — thrown for deleted test-mode
// data and for ids minted under the other key mode.
function isMissingResourceError(error: unknown): boolean {
  return typeof error === "object" && error != null && (error as { code?: unknown }).code === "resource_missing";
}

// The minimal surface the cancel loop touches; worker tests hand in a stub
// (same convention as GitHubAppConfig.testData), production always resolves
// the configured client.
export type StripeSubscriptionGateway = {
  subscriptions: {
    cancel(id: string, params: { prorate: boolean }): Promise<{ status: string }>;
    retrieve(id: string): Promise<{ status: string }>;
  };
};

// Stripe refuses to cancel a subscription that is already canceled, and
// cannot cancel one it no longer knows. Either way nothing is billing —
// which is all account deletion needs — so read the subscription back and
// settle the local row; anything genuinely live (or unreachable) rethrows
// the original cancel failure so deletion still fails closed.
async function settledTerminalStatus(stripe: StripeSubscriptionGateway, id: string, cancelError: unknown): Promise<"canceled" | "incomplete_expired"> {
  if (isMissingResourceError(cancelError)) return "canceled";
  let current: { status: string } | null;
  try {
    current = await stripe.subscriptions.retrieve(id);
  } catch (retrieveError) {
    if (!isMissingResourceError(retrieveError)) throw cancelError;
    current = null;
  }
  if (current && !TERMINAL_STRIPE_STATUSES.has(current.status)) throw cancelError;
  return terminalStripeStatus(current?.status ?? "canceled");
}

// Deliberately NOT reconcileStripeSubscription here: reconcile enforces
// purchase-shaped invariants (a currently configured price, a valid seat
// quantity) that a legacy or test-mode subscription no longer satisfies,
// and a terminal subscription only needs its local row marked terminal.
// Routing cancellation through reconcile wedged account deletion forever:
// the Stripe-side cancel succeeded on the first attempt, reconcile threw
// before the D1 write, and every retry then failed on re-canceling an
// already-canceled subscription.
export async function cancelStripeSubscriptionsForAccount(userId: string, client?: StripeSubscriptionGateway): Promise<void> {
  const ids = await listNonTerminalStripeSubscriptionIds(userId);
  if (ids.length === 0) return;
  const stripe = client ?? getStripeClient();
  for (const id of ids) {
    let status: "canceled" | "incomplete_expired";
    try {
      status = terminalStripeStatus((await stripe.subscriptions.cancel(id, { prorate: false })).status);
    } catch (cancelError) {
      status = await settledTerminalStatus(stripe, id, cancelError);
    }
    await markStripeSubscriptionTerminal(id, userId, status);
  }
}

export type { BillingSummary };

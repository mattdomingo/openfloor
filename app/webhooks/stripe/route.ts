import { claimStripeWebhookEvent, finishStripeWebhookEvent } from "@/db/billing";
import { reconcileStripeEventObject } from "@/lib/stripe-billing";
import { BillingConfigurationError, constructStripeWebhookEvent } from "@/lib/stripe";

const MAX_WEBHOOK_BYTES = 256_000;
const SUPPORTED_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
]);

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Webhook payload is too large" }, { status: 413 });
  }
  const payload = await request.text();
  if (new TextEncoder().encode(payload).byteLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Webhook payload is too large" }, { status: 413 });
  }
  let event;
  try {
    event = await constructStripeWebhookEvent(payload, request.headers.get("stripe-signature"));
  } catch (error) {
    if (error instanceof BillingConfigurationError) {
      return Response.json({ error: "Stripe webhook is unavailable" }, { status: 503 });
    }
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
  const claim = await claimStripeWebhookEvent(event.id, event.type);
  if (claim === "processed") return Response.json({ accepted: true, duplicate: true }, { status: 202 });
  if (!SUPPORTED_EVENTS.has(event.type)) {
    await finishStripeWebhookEvent(event.id, null);
    return Response.json({ accepted: true, ignored: true }, { status: 202 });
  }
  try {
    await reconcileStripeEventObject(event.data.object, event.created);
    await finishStripeWebhookEvent(event.id, null);
    return Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Stripe reconciliation failed.";
    await finishStripeWebhookEvent(event.id, message);
    return Response.json({ error: "Stripe reconciliation failed" }, { status: 500 });
  }
}

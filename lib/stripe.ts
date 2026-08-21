import { env } from "cloudflare:workers";
import Stripe from "stripe";
import type { PaidPlan } from "./plans";

export type StripeBillingConfig = {
  secretKey: string;
  webhookSecret: string;
  priceIds: Record<PaidPlan, string>;
  portalConfigurationId: string;
  checkoutEnabled: boolean;
};

export class BillingConfigurationError extends Error {}

export function getStripeBillingConfig(): StripeBillingConfig {
  const bindings = env as unknown as Record<string, string | undefined>;
  return {
    secretKey: bindings.STRIPE_SECRET_KEY ?? "",
    webhookSecret: bindings.STRIPE_WEBHOOK_SECRET ?? "",
    priceIds: { pro: bindings.STRIPE_PRO_PRICE_ID ?? "", max: bindings.STRIPE_MAX_PRICE_ID ?? "" },
    portalConfigurationId: bindings.STRIPE_PORTAL_CONFIGURATION_ID ?? "",
    checkoutEnabled: bindings.STRIPE_CHECKOUT_ENABLED === "true",
  };
}

export function getStripeClient(): Stripe {
  const config = getStripeBillingConfig();
  if (!config.secretKey) throw new BillingConfigurationError("`STRIPE_SECRET_KEY` is unavailable.");
  return new Stripe(config.secretKey, { httpClient: Stripe.createFetchHttpClient() });
}

export async function constructStripeWebhookEvent(payload: string, signature: string | null): Promise<Stripe.Event> {
  const config = getStripeBillingConfig();
  if (!config.webhookSecret) throw new BillingConfigurationError("`STRIPE_WEBHOOK_SECRET` is unavailable.");
  if (!signature) throw new Error("Missing Stripe webhook signature.");
  return getStripeClient().webhooks.constructEventAsync(
    payload,
    signature,
    config.webhookSecret,
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}

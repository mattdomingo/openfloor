import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POST as receiveStripeWebhook } from "@/app/webhooks/stripe/route";
import { saveStripeCustomer } from "@/db/billing";
import { acceptInvite, createSession, findUserById, getInvitePreview, getUsageForUser, upsertUser } from "@/db/sessions";

function identity(id: string) {
  return { providerUserId: `stripe-${id}`, email: `${id}@example.com`, displayName: `Stripe ${id}`, fullName: `Stripe ${id}` };
}

describe("Stripe entitlement reconciliation", () => {
  it("verifies, deduplicates, orders, and applies subscription events to seat enforcement", async () => {
    const owner = await upsertUser(identity("owner"), env.DB);
    await env.DB.prepare("UPDATE users SET first_name = 'Stripe', last_name = 'Owner' WHERE id = ?").bind(owner.id).run();
    await saveStripeCustomer(owner.id, "cus_owner", env.DB);

    const active = stripeEvent("evt_active", 200, subscription(owner.id, "active", "price_test_pro", 4));
    const accepted = await receiveStripeWebhook(await signedRequest(active));
    expect(accepted.status).toBe(202);
    expect(await findUserById(owner.id, env.DB)).toMatchObject({ plan: "pro", planStatus: "active", seatLimit: 4 });
    expect((await findUserById(owner.id, env.DB))?.onboardedAt).not.toBeNull();
    expect(await getUsageForUser(owner.id, env.DB)).toMatchObject({ effectivePlan: "pro", limitSeats: 4, limitHours: 30 });

    const replay = await receiveStripeWebhook(await signedRequest(active));
    expect(await replay.json()).toEqual(expect.objectContaining({ duplicate: true }));

    // Older delivery arrives after active. event_created guard keeps current
    // Stripe projection instead of rolling access backward.
    const stale = stripeEvent("evt_stale", 100, subscription(owner.id, "canceled", "price_test_pro", 4));
    expect((await receiveStripeWebhook(await signedRequest(stale))).status).toBe(202);
    expect(await findUserById(owner.id, env.DB)).toMatchObject({ planStatus: "active", seatLimit: 4 });

    const created = await createSession(owner.id, { title: "Four-seat room", objective: null }, env.DB);
    const preview = await getInvitePreview(created.inviteId, env.DB);
    expect(preview?.seatLimit).toBe(4);
    for (let index = 0; index < 3; index += 1) {
      const member = await upsertUser(identity(`member-${index}`), env.DB);
      expect(await acceptInvite(created.inviteId, member.id, env.DB)).toBe(created.session.id);
    }
    const extra = await upsertUser(identity("extra"), env.DB);
    expect(await acceptInvite(created.inviteId, extra.id, env.DB)).toBe("full");

    const pastDue = stripeEvent("evt_past_due", 300, subscription(owner.id, "past_due", "price_test_pro", 4));
    expect((await receiveStripeWebhook(await signedRequest(pastDue))).status).toBe(202);
    expect(await getUsageForUser(owner.id, env.DB)).toMatchObject({ effectivePlan: "free", limitSeats: 3, limitHours: 2 });
  });

  it("rejects bad signatures and fails closed on an unsupported price", async () => {
    const user = await upsertUser(identity("unsupported"), env.DB);
    await saveStripeCustomer(user.id, "cus_unsupported", env.DB);
    const event = stripeEvent("evt_unsupported", 400, subscription(user.id, "active", "price_unknown", 5, "cus_unsupported"));
    const invalid = await receiveStripeWebhook(new Request("https://app.opnflr.com/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "bad" }, body: event,
    }));
    expect(invalid.status).toBe(401);

    const failed = await receiveStripeWebhook(await signedRequest(event));
    expect(failed.status).toBe(500);
    expect(await getUsageForUser(user.id, env.DB)).toMatchObject({ effectivePlan: "free", limitSeats: 3 });
  });

  it("acknowledges terminal subscription delivery after account tombstoning", async () => {
    const user = await upsertUser(identity("deleted"), env.DB);
    await saveStripeCustomer(user.id, "cus_deleted", env.DB);
    await env.DB.prepare("UPDATE users SET deleted_at = ?, plan_status = 'canceled' WHERE id = ?")
      .bind(Date.now(), user.id).run();

    const event = stripeEvent("evt_deleted_cancel", 500, subscription(user.id, "canceled", "price_test_pro", 3, "cus_deleted"));
    expect((await receiveStripeWebhook(await signedRequest(event))).status).toBe(202);
  });
});

function subscription(userId: string, status: string, priceId: string, quantity: number, customer = "cus_owner") {
  return {
    id: `sub_${userId}`,
    object: "subscription",
    customer,
    metadata: { openfloor_user_id: userId },
    status,
    cancel_at_period_end: false,
    items: { data: [{ id: `si_${userId}`, quantity, current_period_end: 2_000_000_000, price: { id: priceId } }] },
  };
}

function stripeEvent(id: string, created: number, object: unknown): string {
  return JSON.stringify({ id, object: "event", api_version: "2026-04-29.preview", created, type: "customer.subscription.updated", data: { object } });
}

async function signedRequest(body: string): Promise<Request> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const signed = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("whsec_worker-test-stripe-webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
  const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://app.opnflr.com/webhooks/stripe", {
    method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body,
  });
}

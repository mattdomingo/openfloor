import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { isPaidPlan, validPaidSeatQuantity } from "@/lib/plans";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { BillingConfigurationError, BillingConflictError, createStripeCheckout } from "@/lib/stripe-billing";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  if (user.onboardedAt == null) return Response.json({ error: "Finish account setup first." }, { status: 409 });
  const body = await request.json().catch(() => null) as { plan?: unknown; quantity?: unknown; returnTo?: unknown } | null;
  if (!isPaidPlan(body?.plan) || !validPaidSeatQuantity(body.plan, body?.quantity)) {
    return Response.json({ error: "Choose a valid paid plan and seat quantity." }, { status: 400 });
  }
  const returnTo = safeAppReturnPath(body?.returnTo) ?? `${BASE_PATH}/settings?section=plan`;
  try {
    const url = await createStripeCheckout(user, {
      plan: body.plan, quantity: body.quantity, requestUrl: request.url, returnTo, cancelTo: "/settings?section=plan&billing=cancelled",
    });
    return Response.json({ url });
  } catch (error) {
    if (error instanceof BillingConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof BillingConfigurationError) return Response.json({ error: error.message }, { status: 503 });
    throw error;
  }
}


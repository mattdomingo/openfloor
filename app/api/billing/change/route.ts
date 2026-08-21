import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { isPaidPlan, validPaidSeatQuantity } from "@/lib/plans";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { BillingConfigurationError, BillingConflictError, createStripePlanChange } from "@/lib/stripe-billing";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const body = await request.json().catch(() => null) as { plan?: unknown; quantity?: unknown; returnTo?: unknown } | null;
  if (!isPaidPlan(body?.plan) || !validPaidSeatQuantity(body.plan, body?.quantity)) {
    return Response.json({ error: "Choose a valid paid plan and seat quantity." }, { status: 400 });
  }
  const returnTo = safeAppReturnPath(body.returnTo) ?? `${BASE_PATH}/settings?section=plan`;
  try {
    return Response.json({ url: await createStripePlanChange(user, {
      plan: body.plan, quantity: body.quantity, requestUrl: request.url, returnTo,
    }) });
  } catch (error) {
    if (error instanceof BillingConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof BillingConfigurationError) return Response.json({ error: error.message }, { status: 503 });
    throw error;
  }
}


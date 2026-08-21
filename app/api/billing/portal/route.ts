import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { BillingConfigurationError, createStripePortal } from "@/lib/stripe-billing";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const body = await request.json().catch(() => null) as { returnTo?: unknown } | null;
  const returnTo = safeAppReturnPath(body?.returnTo) ?? `${BASE_PATH}/settings?section=plan`;
  try {
    return Response.json({ url: await createStripePortal(user, request.url, returnTo) });
  } catch (error) {
    if (error instanceof BillingConfigurationError) return Response.json({ error: error.message }, { status: 503 });
    throw error;
  }
}


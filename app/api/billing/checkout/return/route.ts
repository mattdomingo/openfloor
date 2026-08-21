import { redirect } from "next/navigation";
import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { reconcileStripeCheckout } from "@/lib/stripe-billing";

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id")?.trim();
  const returnTo = safeAppReturnPath(url.searchParams.get("return_to")) ?? `${BASE_PATH}/settings?section=plan`;
  if (!sessionId || sessionId.length > 200) return Response.json({ error: "Missing Stripe Checkout session." }, { status: 400 });
  await reconcileStripeCheckout(sessionId, user.id);
  redirect(returnTo);
}

import { completeOnboarding, savePendingOnboardingProfile } from "@/db/sessions";
import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { putAvatar } from "@/lib/account-avatar";
import { validInviteOnboardingReturn } from "@/lib/onboarding-plan";
import { isPaidPlan, validPaidSeatQuantity } from "@/lib/plans";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { BillingConfigurationError, BillingConflictError, createStripeCheckout } from "@/lib/stripe-billing";
import { parseProfileInput } from "@/lib/validation";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  const form = await request.formData();
  const returnTo = safeAppReturnPath(form.get("returnTo")) ?? `${BASE_PATH}/home`;
  const inviteSignup = await validInviteOnboardingReturn(returnTo);
  const requestedPlan = String(form.get("plan") ?? "");
  const plan = inviteSignup ? "free" : requestedPlan;
  const quantity = Number(form.get("quantity"));
  if (plan !== "free" && (!isPaidPlan(plan) || !validPaidSeatQuantity(plan, quantity))) {
    return Response.json({ error: "Choose Free, Pro, or Max with a valid seat quantity." }, { status: 400 });
  }
  const input = parseProfileInput({
    firstName: String(form.get("firstName") ?? ""),
    lastName: String(form.get("lastName") ?? ""),
    githubHandle: String(form.get("githubHandle") ?? ""),
  });
  if (!input) return Response.json({ error: "A first and last name are required." }, { status: 400 });

  const avatar = form.get("avatar");
  let avatarKey: string | null = null;
  if (avatar instanceof File && avatar.size > 0) {
    const uploaded = await putAvatar(user.id, avatar);
    if (!uploaded.ok) return Response.json({ error: uploaded.error }, { status: uploaded.status });
    avatarKey = uploaded.key;
  }

  if (plan === "free") {
    await completeOnboarding(user.id, { ...input, avatarKey });
    return Response.json({ url: returnTo });
  }

  const updated = await savePendingOnboardingProfile(user.id, { ...input, avatarKey });
  try {
    const cancelTo = `/onboarding?return_to=${encodeURIComponent(returnTo)}&billing=cancelled`;
    const url = await createStripeCheckout(updated, {
      plan, quantity, requestUrl: request.url, returnTo, cancelTo,
    });
    return Response.json({ url });
  } catch (error) {
    if (error instanceof BillingConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof BillingConfigurationError) return Response.json({ error: error.message }, { status: 503 });
    throw error;
  }
}

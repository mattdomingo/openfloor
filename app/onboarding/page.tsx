import { redirect } from "next/navigation";
import { requireAccessUser, safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { upsertUser } from "@/db/sessions";
import { OnboardingScreen } from "@/components/product/OnboardingScreen";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const { return_to } = await searchParams;
  const returnTo = safeAppReturnPath(return_to) ?? `${BASE_PATH}/home`;
  const identity = await requireAccessUser("/onboarding");
  const user = await upsertUser(identity);
  if (user.onboardedAt != null) redirect(returnTo);
  return <OnboardingScreen fullName={identity.fullName} returnTo={returnTo} />;
}

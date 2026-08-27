import { redirect } from "next/navigation";
import { requireAccessUser, safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { upsertUser } from "@/db/sessions";
import { OnboardingScreen } from "@/components/product/OnboardingScreen";
import { parseOnboardingStep, validInviteOnboardingReturn } from "@/lib/onboarding-plan";
import { listUserGitHubInstallations } from "@/db/github-installations";
import { listProviderCredentials } from "@/db/provider-credentials";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string; github?: string; step?: string }>;
}) {
  const { return_to, github, step } = await searchParams;
  const returnTo = safeAppReturnPath(return_to) ?? `${BASE_PATH}/home`;
  const identity = await requireAccessUser("/onboarding");
  const user = await upsertUser(identity);
  if (user.onboardedAt != null) redirect(returnTo);
  const inviteReturnTo = await validInviteOnboardingReturn(returnTo);
  const [githubInstallations, credentials] = await Promise.all([
    listUserGitHubInstallations(user.id),
    listProviderCredentials(user.id),
  ]);
  return <OnboardingScreen
    fullName={identity.fullName}
    firstName={user.firstName}
    lastName={user.lastName}
    githubHandle={user.githubHandle}
    returnTo={returnTo}
    inviteSignup={inviteReturnTo != null}
    githubInstallations={githubInstallations}
    githubConnected={github === "connected"}
    initialCredentials={credentials}
    initialStep={parseOnboardingStep(step)}
  />;
}

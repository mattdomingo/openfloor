import { disabledRunProviders } from "@/lib/provider-rollout";
import { CREDENTIAL_PROVIDERS } from "@/lib/provider-credentials";
import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { requireEarlyAccessContext } from "@/lib/server-auth";
import { OnboardingScreen } from "@/components/product/OnboardingScreen";
import { normalizedTeamDomain } from "@/lib/identity";
import { parseOnboardingStep } from "@/lib/onboarding-plan";
import { listUserGitHubInstallations } from "@/db/github-installations";
import { listProviderCredentials } from "@/db/provider-credentials";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string; step?: string }>;
}) {
  const { return_to, step } = await searchParams;
  const returnTo = safeAppReturnPath(return_to) ?? `${BASE_PATH}/home`;
  const { identity, user } = await requireEarlyAccessContext("/onboarding");
  if (user.onboardedAt != null) redirect(returnTo);
  const [githubInstallations, credentials] = await Promise.all([
    listUserGitHubInstallations(user.id),
    listProviderCredentials(user.id),
  ]);
  // Same team-domain validation app/signout/route.ts uses, so the
  // back-button/tab-close exit (useOnboardingExit) can end that global
  // Access session the same way an explicit sign-out does.
  const teamDomain = normalizedTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const teamLogoutUrl = teamDomain ? `${teamDomain}/cdn-cgi/access/logout` : null;
  return <OnboardingScreen
    fullName={identity.fullName}
    firstName={user.firstName}
    lastName={user.lastName}
    githubHandle={user.githubHandle}
    returnTo={returnTo}
    githubInstallations={githubInstallations}
    initialCredentials={credentials}
    enabledProviders={CREDENTIAL_PROVIDERS.filter((provider) => !disabledRunProviders().has(provider))}
    initialStep={parseOnboardingStep(step)}
    teamLogoutUrl={teamLogoutUrl}
  />;
}

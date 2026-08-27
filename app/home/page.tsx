import { requireOnboardedUser } from "@/lib/server-auth";
import { getUsageForUser, listSessionsForUser } from "@/db/sessions";
import { getMonthlyModelUsage, listProviderCredentials } from "@/db/provider-credentials";
import { CREDENTIAL_PROVIDERS } from "@/lib/provider-credentials";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { HomeScreen } from "@/components/product/HomeScreen";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireOnboardedUser("/home");
  const [sessions, usage, credentials, modelUsage] = await Promise.all([
    listSessionsForUser(user.id),
    getUsageForUser(user.id),
    listProviderCredentials(user.id),
    getMonthlyModelUsage(user.id),
  ]);
  const disabled = disabledRunProviders();
  const enabledProviders = CREDENTIAL_PROVIDERS.filter((provider) => !disabled.has(provider));
  return <HomeScreen user={user} sessions={sessions} usage={usage} initialCredentials={credentials} enabledProviders={enabledProviders} modelUsage={modelUsage} />;
}

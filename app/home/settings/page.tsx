import { requireOnboardedUser } from "@/lib/server-auth";
import { getUsageForUser } from "@/db/sessions";
import { listProviderCredentials } from "@/db/provider-credentials";
import { isSettingsSection, SettingsScreen } from "@/components/product/SettingsScreen";
import { getBillingSummary } from "@/db/billing";
import { resolveSettingsOrigin } from "./origin";
import { listUserGitHubInstallations } from "@/db/github-installations";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string; billing?: string; from?: string }> }) {
  const user = await requireOnboardedUser("/home/settings");
  const query = await searchParams;
  const [usage, billing, credentials, githubInstallations, origin] = await Promise.all([
    getUsageForUser(user.id),
    getBillingSummary(user.id),
    listProviderCredentials(user.id),
    listUserGitHubInstallations(user.id),
    resolveSettingsOrigin(query.from, user.id),
  ]);
  return (
    <SettingsScreen
      user={user}
      usage={usage}
      billing={billing}
      credentials={credentials}
      githubInstallations={githubInstallations}
      initialSection={isSettingsSection(query.section) ? query.section : "profile"}
      billingNotice={query.billing ?? null}
      backTo={origin}
      originPath={origin.href === "/home" ? null : origin.href}
    />
  );
}

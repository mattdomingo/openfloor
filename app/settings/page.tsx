import { requireOnboardedUser } from "@/lib/server-auth";
import { getUsageForUser } from "@/db/sessions";
import { listProviderCredentials } from "@/db/provider-credentials";
import { SettingsScreen } from "@/components/product/SettingsScreen";
import { getBillingSummary } from "@/db/billing";
import { resolveSettingsOrigin } from "./origin";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string; billing?: string; from?: string }> }) {
  const user = await requireOnboardedUser("/settings");
  const query = await searchParams;
  const [usage, billing, credentials, origin] = await Promise.all([
    getUsageForUser(user.id),
    getBillingSummary(user.id),
    listProviderCredentials(user.id),
    resolveSettingsOrigin(query.from, user.id),
  ]);
  return (
    <SettingsScreen
      user={user}
      usage={usage}
      billing={billing}
      credentials={credentials}
      initialSection={query.section === "plan" ? "plan" : "profile"}
      billingNotice={query.billing ?? null}
      backTo={origin}
      originPath={origin.href === "/home" ? null : origin.href}
    />
  );
}

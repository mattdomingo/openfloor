import { requireOnboardedUser } from "@/lib/server-auth";
import { getUsageForUser } from "@/db/sessions";
import { listProviderCredentials } from "@/db/provider-credentials";
import { SettingsScreen } from "@/components/product/SettingsScreen";
import { getBillingSummary } from "@/db/billing";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string; billing?: string }> }) {
  const user = await requireOnboardedUser("/settings");
  const [usage, billing, credentials] = await Promise.all([
    getUsageForUser(user.id),
    getBillingSummary(user.id),
    listProviderCredentials(user.id),
  ]);
  const query = await searchParams;
  return <SettingsScreen user={user} usage={usage} billing={billing} credentials={credentials} initialSection={query.section === "plan" ? "plan" : "profile"} billingNotice={query.billing ?? null} />;
}

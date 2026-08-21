import { requireOnboardedUser } from "@/lib/server-auth";
import { getUsageForUser } from "@/db/sessions";
import { SettingsScreen } from "@/components/product/SettingsScreen";
import { getBillingSummary } from "@/db/billing";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string; billing?: string }> }) {
  const user = await requireOnboardedUser("/settings");
  const [usage, billing] = await Promise.all([getUsageForUser(user.id), getBillingSummary(user.id)]);
  const query = await searchParams;
  return <SettingsScreen user={user} usage={usage} billing={billing} initialSection={query.section === "plan" ? "plan" : "profile"} billingNotice={query.billing ?? null} />;
}

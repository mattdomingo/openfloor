import { requireOnboardedUser } from "@/lib/server-auth";
import { getUsageForUser } from "@/db/sessions";
import { SettingsScreen } from "@/components/product/SettingsScreen";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireOnboardedUser("/settings");
  const usage = await getUsageForUser(user.id);
  return <SettingsScreen user={user} usage={usage} />;
}

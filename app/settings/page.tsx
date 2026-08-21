import { requireOnboardedUser } from "@/lib/server-auth";
import { getUsageForUser } from "@/db/sessions";
import { listProviderCredentials } from "@/db/provider-credentials";
import { SettingsScreen } from "@/components/product/SettingsScreen";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireOnboardedUser("/settings");
  const usage = await getUsageForUser(user.id);
  const credentials = await listProviderCredentials(user.id);
  return <SettingsScreen user={user} usage={usage} credentials={credentials} />;
}

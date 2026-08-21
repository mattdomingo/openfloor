import { requireOnboardedUser } from "@/lib/server-auth";
import { getUsageForUser, listSessionsForUser } from "@/db/sessions";
import { HomeScreen } from "@/components/product/HomeScreen";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requireOnboardedUser("/home");
  const sessions = await listSessionsForUser(user.id);
  const usage = await getUsageForUser(user.id);
  return <HomeScreen user={user} sessions={sessions} usage={usage} />;
}

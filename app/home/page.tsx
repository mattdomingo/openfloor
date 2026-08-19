import { requireAccessUser } from "@/app/access-auth";
import { listSessionsForUser, upsertUser } from "@/db/sessions";
import { HomeScreen } from "@/components/product/HomeScreen";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const identity = await requireAccessUser("/home");
  const user = await upsertUser(identity);
  const sessions = await listSessionsForUser(user.id);
  return <HomeScreen user={user} sessions={sessions} />;
}

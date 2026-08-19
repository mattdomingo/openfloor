import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { listSessionsForUser, upsertUser } from "@/db/sessions";
import { HomeScreen } from "@/components/product/HomeScreen";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const identity = await requireChatGPTUser("/home");
  const user = await upsertUser(identity);
  const sessions = await listSessionsForUser(user.id);
  return <HomeScreen user={user} sessions={sessions} />;
}

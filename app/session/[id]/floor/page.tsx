import { notFound } from "next/navigation";
import { requireAccessUser } from "@/app/access-auth";
import { AgentFloorScreen } from "@/components/product/AgentFloorScreen";
import { getSessionForMember, getSessionMembers, upsertUser } from "@/db/sessions";

export const dynamic = "force-dynamic";

export default async function AgentFloorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireAccessUser(`/session/${encodeURIComponent(id)}/floor`);
  const user = await upsertUser(identity);
  const [session, members] = await Promise.all([getSessionForMember(id, user.id), getSessionMembers(id, user.id)]);
  if (!session || !members) notFound();
  return <AgentFloorScreen user={user} session={session} initialMembers={members} />;
}

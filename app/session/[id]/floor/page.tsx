import { notFound } from "next/navigation";
import { requireAccessUser } from "@/app/access-auth";
import { AgentFloorScreen } from "@/components/product/AgentFloorScreen";
import { getSessionForMember, getSessionMembers, upsertUser } from "@/db/sessions";
import { getFloorSnapshot } from "@/db/floor";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export default async function AgentFloorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireAccessUser(`/session/${encodeURIComponent(id)}/floor`);
  const user = await upsertUser(identity);
  const [session, members, floor] = await Promise.all([
    getSessionForMember(id, user.id),
    getSessionMembers(id, user.id),
    getFloorSnapshot(id, user.id),
  ]);
  if (!session || !members || !floor) notFound();
  const agentRunEnabled = (env as unknown as { AGENT_RUN_ENABLED?: string }).AGENT_RUN_ENABLED === "true";
  return <AgentFloorScreen user={user} session={session} initialMembers={members} initialFloor={floor} agentRunEnabled={agentRunEnabled} />;
}

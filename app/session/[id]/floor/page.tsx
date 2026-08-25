import { notFound, redirect } from "next/navigation";
import { requireOnboardedUser } from "@/lib/server-auth";
import { AgentFloorScreen } from "@/components/product/AgentFloorScreen";
import { getSessionForMember, getSessionMembers } from "@/db/sessions";
import { getActiveRepositoryCandidateForMember, getRepositoryConnectionForMember } from "@/db/repositories";
import { getFloorSnapshot } from "@/db/floor";
import { isRepositoryReadyForFloor } from "@/lib/repository-gate";
import { disabledRunProviders } from "@/lib/agent-run-start";
import { CREDENTIAL_PROVIDERS } from "@/lib/provider-credentials";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export default async function AgentFloorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireOnboardedUser(`/session/${encodeURIComponent(id)}/floor`);
  const [session, members, floor, repository, candidate] = await Promise.all([
    getSessionForMember(id, user.id),
    getSessionMembers(id, user.id),
    getFloorSnapshot(id, user.id),
    getRepositoryConnectionForMember(id, user.id),
    getActiveRepositoryCandidateForMember(id, user.id),
  ]);
  if (!session || !members || !floor) notFound();
  if (session.endedAt == null && !isRepositoryReadyForFloor(repository, candidate)) {
    redirect(`/session/${encodeURIComponent(id)}?repo=required`);
  }
  const agentRunEnabled = (env as unknown as { AGENT_RUN_ENABLED?: string }).AGENT_RUN_ENABLED === "true";
  const disabled = disabledRunProviders();
  const enabledProviders = CREDENTIAL_PROVIDERS.filter((provider) => !disabled.has(provider));
  return <AgentFloorScreen user={user} session={session} initialMembers={members} initialFloor={floor} agentRunEnabled={agentRunEnabled} enabledProviders={enabledProviders} />;
}

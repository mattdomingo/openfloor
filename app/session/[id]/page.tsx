import { notFound } from "next/navigation";
import { requireOnboardedUser } from "@/lib/server-auth";
import { getOwnerHourQuota, getRemovedSessionMembers, getSessionForMember, getSessionMembers } from "@/db/sessions";
import { getActiveRepositoryCandidateForMember, getRepositoryConnectionForMember } from "@/db/repositories";
import { listSessionMcpServersForMember } from "@/db/mcp-servers";
import { listSessionSkillsForMember } from "@/db/skills";
import { listProviderCredentials } from "@/db/provider-credentials";
import { SessionScreen } from "@/components/product/SessionScreen";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { lowHoursRemaining, PLAN_LIMITS } from "@/lib/plans";
import { CREDENTIAL_PROVIDERS } from "@/lib/provider-credentials";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ repo?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  return <AuthenticatedSession id={id} repoGateRequested={query.repo === "required"} />;
}

async function AuthenticatedSession({ id, repoGateRequested }: { id: string; repoGateRequested: boolean }) {
  const user = await requireOnboardedUser(`/session/${encodeURIComponent(id)}`);
  const [session, members, removedMembers, repository, candidate, skills, mcpServers, quota, credentials] = await Promise.all([
    getSessionForMember(id, user.id),
    getSessionMembers(id, user.id),
    getRemovedSessionMembers(id, user.id),
    getRepositoryConnectionForMember(id, user.id),
    getActiveRepositoryCandidateForMember(id, user.id),
    listSessionSkillsForMember(id, user.id),
    listSessionMcpServersForMember(id, user.id),
    // The same owner-scoped read the presence gate makes on every socket
    // upgrade, reused here so the lobby can warn before that gate bites.
    getOwnerHourQuota(id),
    listProviderCredentials(user.id),
  ]);
  if (!session || !members) notFound();
  const disabled = disabledRunProviders();
  const enabledProviders = CREDENTIAL_PROVIDERS.filter((provider) => !disabled.has(provider));
  const lowHours = quota ? lowHoursRemaining(quota.seconds, PLAN_LIMITS[quota.plan].hours) : null;
  return <SessionScreen user={user} session={session} initialMembers={members} initialRemovedMembers={removedMembers ?? []} initialRepository={repository} initialCandidate={candidate} enabledProviders={enabledProviders} initialCredentials={credentials} initialSkills={skills ?? []} initialMcpServers={mcpServers ?? []} repoGateRequested={repoGateRequested} lowHoursRemaining={lowHours} />;
}

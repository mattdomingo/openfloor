import { notFound } from "next/navigation";
import { requireOnboardedUser } from "@/lib/server-auth";
import { getOwnerHourQuota, getRemovedSessionMembers, getSessionForMember, getSessionMembers } from "@/db/sessions";
import { getActiveRepositoryCandidateForMember, getRepositoryConnectionForMember } from "@/db/repositories";
import { getLatestRepositoryPreflightForMember } from "@/db/preflights";
import { listSessionMcpServersForMember } from "@/db/mcp-servers";
import { listSessionSkillsForMember } from "@/db/skills";
import { listProviderCredentials } from "@/db/provider-credentials";
import { SessionScreen } from "@/components/product/SessionScreen";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { lowHoursRemaining, PLAN_LIMITS } from "@/lib/plans";
import { CREDENTIAL_PROVIDERS } from "@/lib/provider-credentials";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ github?: string; repo?: string; setup?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  return <AuthenticatedSession id={id} githubSetup={query.github === "setup"} repoGateRequested={query.repo === "required"} setupRequested={query.setup === "1"} />;
}

async function AuthenticatedSession({ id, githubSetup, repoGateRequested, setupRequested }: { id: string; githubSetup: boolean; repoGateRequested: boolean; setupRequested: boolean }) {
  const user = await requireOnboardedUser(`/session/${encodeURIComponent(id)}`);
  const [session, members, removedMembers, repository, candidate, preflight, skills, mcpServers, credentials, quota] = await Promise.all([
    getSessionForMember(id, user.id),
    getSessionMembers(id, user.id),
    getRemovedSessionMembers(id, user.id),
    getRepositoryConnectionForMember(id, user.id),
    getActiveRepositoryCandidateForMember(id, user.id),
    getLatestRepositoryPreflightForMember(id, user.id),
    listSessionSkillsForMember(id, user.id),
    listSessionMcpServersForMember(id, user.id),
    listProviderCredentials(user.id),
    // The same owner-scoped read the presence gate makes on every socket
    // upgrade, reused here so the lobby can warn before that gate bites.
    getOwnerHourQuota(id),
  ]);
  if (!session || !members) notFound();
  const preflightEnabled = (env as unknown as { PREFLIGHT_ENABLED?: string }).PREFLIGHT_ENABLED === "true";
  const disabled = disabledRunProviders();
  const enabledProviders = CREDENTIAL_PROVIDERS.filter((provider) => !disabled.has(provider));
  const lowHours = quota ? lowHoursRemaining(quota.seconds, PLAN_LIMITS[quota.plan].hours) : null;
  return <SessionScreen user={user} session={session} initialMembers={members} initialRemovedMembers={removedMembers ?? []} initialRepository={repository} initialCandidate={candidate} initialPreflight={preflight} preflightEnabled={preflightEnabled} enabledProviders={enabledProviders} initialCredentials={credentials} initialSkills={skills ?? []} initialMcpServers={mcpServers ?? []} githubSetup={githubSetup} repoGateRequested={repoGateRequested} setupRequested={setupRequested} lowHoursRemaining={lowHours} />;
}

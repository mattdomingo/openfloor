import { notFound } from "next/navigation";
import { requireOnboardedUser } from "@/lib/server-auth";
import { getRemovedSessionMembers, getSessionForMember, getSessionMembers } from "@/db/sessions";
import { getActiveRepositoryCandidateForMember, getRepositoryConnectionForMember } from "@/db/repositories";
import { getLatestRepositoryPreflightForMember } from "@/db/preflights";
import { SessionScreen } from "@/components/product/SessionScreen";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ github?: string; repo?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  return <AuthenticatedSession id={id} githubSetup={query.github === "setup"} repoGateRequested={query.repo === "required"} />;
}

async function AuthenticatedSession({ id, githubSetup, repoGateRequested }: { id: string; githubSetup: boolean; repoGateRequested: boolean }) {
  const user = await requireOnboardedUser(`/session/${encodeURIComponent(id)}`);
  const [session, members, removedMembers, repository, candidate, preflight] = await Promise.all([
    getSessionForMember(id, user.id),
    getSessionMembers(id, user.id),
    getRemovedSessionMembers(id, user.id),
    getRepositoryConnectionForMember(id, user.id),
    getActiveRepositoryCandidateForMember(id, user.id),
    getLatestRepositoryPreflightForMember(id, user.id),
  ]);
  if (!session || !members) notFound();
  const preflightEnabled = (env as unknown as { PREFLIGHT_ENABLED?: string }).PREFLIGHT_ENABLED === "true";
  return <SessionScreen user={user} session={session} initialMembers={members} initialRemovedMembers={removedMembers ?? []} initialRepository={repository} initialCandidate={candidate} initialPreflight={preflight} preflightEnabled={preflightEnabled} githubSetup={githubSetup} repoGateRequested={repoGateRequested} />;
}

import { notFound } from "next/navigation";
import { requireAccessUser } from "@/app/access-auth";
import { getSessionForMember, getSessionMembers, upsertUser } from "@/db/sessions";
import { getRepositoryConnectionForMember } from "@/db/repositories";
import { SessionScreen } from "@/components/product/SessionScreen";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ github?: string }>;
}) {
  const { id } = await params;
  return <AuthenticatedSession id={id} githubSetup={(await searchParams).github === "setup"} />;
}

async function AuthenticatedSession({ id, githubSetup }: { id: string; githubSetup: boolean }) {
  const identity = await requireAccessUser(`/session/${encodeURIComponent(id)}`);
  const user = await upsertUser(identity);
  const [session, members, repository] = await Promise.all([
    getSessionForMember(id, user.id),
    getSessionMembers(id, user.id),
    getRepositoryConnectionForMember(id, user.id),
  ]);
  if (!session || !members) notFound();
  return <SessionScreen user={user} session={session} initialMembers={members} initialRepository={repository} githubSetup={githubSetup} />;
}

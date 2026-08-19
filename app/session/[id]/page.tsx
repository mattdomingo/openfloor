import { notFound } from "next/navigation";
import { requireAccessUser } from "@/app/access-auth";
import { getSessionForMember, getSessionMembers, upsertUser } from "@/db/sessions";
import { SessionScreen } from "@/components/product/SessionScreen";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuthenticatedSession id={id} />;
}

async function AuthenticatedSession({ id }: { id: string }) {
  const identity = await requireAccessUser(`/session/${encodeURIComponent(id)}`);
  const user = await upsertUser(identity);
  const [session, members] = await Promise.all([getSessionForMember(id, user.id), getSessionMembers(id, user.id)]);
  if (!session || !members) notFound();
  return <SessionScreen user={user} session={session} initialMembers={members} />;
}

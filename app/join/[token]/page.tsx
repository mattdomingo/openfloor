import { notFound } from "next/navigation";
import { requireAccessUser } from "@/app/access-auth";
import { getInviteSigningSecret } from "@/db";
import { getInvitePreview, upsertUser } from "@/db/sessions";
import { verifyInviteToken } from "@/lib/invites";
import { JoinScreen } from "@/components/product/JoinScreen";

export const dynamic = "force-dynamic";

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AuthenticatedInvite token={token} />;
}

async function AuthenticatedInvite({ token }: { token: string }) {
  const identity = await requireAccessUser(`/join/${encodeURIComponent(token)}`);
  await upsertUser(identity);
  const inviteId = await verifyInviteToken(token, getInviteSigningSecret());
  if (!inviteId) notFound();
  const preview = await getInvitePreview(inviteId);
  if (!preview) notFound();
  return <JoinScreen token={token} preview={preview} displayName={identity.displayName} />;
}

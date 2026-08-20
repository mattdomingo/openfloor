import { notFound } from "next/navigation";
import { requireOnboardedUser } from "@/lib/server-auth";
import { getInviteSigningSecret } from "@/db";
import { getInvitePreview } from "@/db/sessions";
import { verifyInviteToken } from "@/lib/invites";
import { JoinScreen } from "@/components/product/JoinScreen";

export const dynamic = "force-dynamic";

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AuthenticatedInvite token={token} />;
}

async function AuthenticatedInvite({ token }: { token: string }) {
  const user = await requireOnboardedUser(`/join/${encodeURIComponent(token)}`);
  const inviteId = await verifyInviteToken(token, getInviteSigningSecret());
  if (!inviteId) notFound();
  const preview = await getInvitePreview(inviteId);
  if (!preview) notFound();
  return <JoinScreen token={token} preview={preview} displayName={user.displayName} />;
}

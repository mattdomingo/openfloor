import { BASE_PATH } from "@/components/basePath";
import { activeOwnerErrorResponse } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";

// Retained temporarily as a rollback-safe API boundary. Session-bound GitHub
// installation states are no longer created or consumed by live product code.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const ownerError = await activeOwnerErrorResponse((await params).id, user.id);
  if (ownerError) return ownerError;
  return Response.json({
    error: "GitHub access is managed in Account Settings.",
    settingsUrl: `${BASE_PATH}/home/settings?section=connections`,
  }, { status: 410 });
}

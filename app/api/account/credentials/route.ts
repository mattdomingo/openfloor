import { listProviderCredentials } from "@/db/provider-credentials";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET() {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const credentials = await listProviderCredentials(user.id);
  return Response.json({ credentials });
}

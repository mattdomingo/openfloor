import { getDb } from "@/db";
import { notifyCredentialChange } from "@/lib/credential-changes";
import { parseCredentialProvider } from "@/lib/provider-credentials";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { setDoNotDisturb } from "@/db/sessions";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function PATCH(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  const body = await request.json().catch(() => null) as { doNotDisturb?: unknown; defaultApiProvider?: unknown } | null;
  if (body && Object.hasOwn(body, "defaultApiProvider")) {
    const provider = body.defaultApiProvider === null ? null : parseCredentialProvider(body.defaultApiProvider);
    if (body.defaultApiProvider !== null && !provider) return Response.json({ error: "Unknown default provider" }, { status: 400 });
    if (provider && (disabledRunProviders().has(provider) || !await getDb().prepare("SELECT 1 FROM user_provider_credentials WHERE user_id = ? AND provider = ? AND kind = 'api_key'").bind(user.id, provider).first())) {
      return Response.json({ error: "Choose an enabled, connected API key." }, { status: 400 });
    }
    await getDb().prepare("UPDATE users SET default_api_provider = ?, updated_at = ? WHERE id = ?").bind(provider, Date.now(), user.id).run();
    await notifyCredentialChange(user.id);
    return Response.json({ user: { ...user, defaultApiProvider: provider } });
  }
  if (!body || typeof body.doNotDisturb !== "boolean") {
    return Response.json({ error: "doNotDisturb must be a boolean" }, { status: 400 });
  }

  const updated = await setDoNotDisturb(user.id, body.doNotDisturb);
  return Response.json({ user: updated });
}

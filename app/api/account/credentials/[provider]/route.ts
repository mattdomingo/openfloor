import { getCredentialEncryptionSecret, getTestProviderKeys } from "@/db/index";
import { deleteProviderCredential, upsertProviderCredential } from "@/db/provider-credentials";
import { encryptCredential } from "@/lib/credential-crypto";
import { credentialFingerprint, parseCredentialProvider, providerLabel } from "@/lib/provider-credentials";
import { validateProviderApiKey } from "@/lib/provider-validation";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseCredentialConnectInput } from "@/lib/validation";

// Stored credentials are write-only from the client's perspective: PUT accepts
// a key and returns only the summary (fingerprint, timestamps); no endpoint
// ever returns a stored value.

export async function PUT(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const provider = parseCredentialProvider((await params).provider);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 404 });
  const body = await request.json().catch(() => null);
  const input = parseCredentialConnectInput(body);
  if (!input) return Response.json({ error: "apiKey must be a single token of at most 512 characters" }, { status: 400 });
  const check = await validateProviderApiKey(provider, input.apiKey, { testAcceptedKeys: getTestProviderKeys() });
  if (!check.ok) {
    return check.reason === "unauthorized"
      ? Response.json({ error: `${providerLabel(provider)} rejected that API key.` }, { status: 400 })
      : Response.json({ error: `${providerLabel(provider)} could not be reached to verify the key. Try again.` }, { status: 502 });
  }
  const ciphertext = await encryptCredential(input.apiKey, getCredentialEncryptionSecret(), `${user.id}:${provider}`);
  const credential = await upsertProviderCredential(user.id, provider, {
    kind: "api_key",
    ciphertext,
    fingerprint: credentialFingerprint(input.apiKey),
    validatedAt: Date.now(),
  });
  return Response.json({ credential });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const provider = parseCredentialProvider((await params).provider);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 404 });
  await deleteProviderCredential(user.id, provider);
  return new Response(null, { status: 204 });
}

import { notifyCredentialChange } from "@/lib/credential-changes";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { getCredentialEncryptionSecret, getTestProviderKeys } from "@/db/index";
import { deleteProviderCredential, setProviderCredentialLimit, upsertProviderCredential } from "@/db/provider-credentials";
import { encryptCredential } from "@/lib/credential-crypto";
import {
  availableCredentialKinds,
  credentialAadContext,
  credentialFingerprint,
  credentialKindsForProvider,
  parseCredentialKind,
  parseCredentialProvider,
  providerLabel,
} from "@/lib/provider-credentials";
import { validateProviderApiKey, validateProviderOauthSecret } from "@/lib/provider-validation";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseCredentialConnectInput, parseCredentialLimitInput } from "@/lib/validation";

// Stored credentials are write-only from the client's perspective: PUT accepts
// a secret and returns only the summary (fingerprint, timestamps); no endpoint
// ever returns a stored value.

export async function PUT(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const provider = parseCredentialProvider((await params).provider);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 404 });
  if (disabledRunProviders().has(provider)) return Response.json({ error: `${providerLabel(provider)} is unavailable in this environment.` }, { status: 409 });
  const body = await request.json().catch(() => null);
  const input = parseCredentialConnectInput(body);
  if (!input) {
    return Response.json({ error: "Send exactly one of apiKey, setupToken, or authJson, within its size limit" }, { status: 400 });
  }
  if (!availableCredentialKinds(provider).includes(input.kind)) {
    return Response.json({ error: `${providerLabel(provider)} does not accept a subscription credential.` }, { status: 400 });
  }
  // API keys validate against the provider's models endpoint on connect;
  // a Claude setup token validates the same way (GET /v1/models, plain
  // Bearer — Spike C rerun). Where no free probe exists (a ChatGPT auth
  // bundle), the row stores validated_at = null ("Connected — not yet
  // verified") and the first run is the real validation. Never fake a
  // validation timestamp.
  let validatedAt: number | null = null;
  const check = input.kind === "api_key"
    ? await validateProviderApiKey(provider, input.secret, { testAcceptedKeys: getTestProviderKeys() })
    : await validateProviderOauthSecret(provider, input.secret, { testAcceptedKeys: getTestProviderKeys() });
  if (check) {
    if (!check.ok) {
      const noun = input.kind === "api_key" ? "API key" : "setup token";
      return check.reason === "unauthorized"
        ? Response.json({ error: `${providerLabel(provider)} rejected that ${noun}.` }, { status: 400 })
        : Response.json({ error: `${providerLabel(provider)} could not be reached to verify the ${noun}. Try again.` }, { status: 502 });
    }
    validatedAt = Date.now();
  }
  const ciphertext = await encryptCredential(input.secret, getCredentialEncryptionSecret(), credentialAadContext(user.id, provider, input.kind));
  const credential = await upsertProviderCredential(user.id, provider, {
    kind: input.kind,
    ciphertext,
    fingerprint: credentialFingerprint(input.fingerprintValue),
    validatedAt,
  });
  await notifyCredentialChange(user.id);
  return Response.json({ credential });
}

// Sets or clears the owner's monthly spend cap for one (provider, kind)
// credential — the only mutable field on a stored credential row besides the
// secret itself. lib/agent-run-start.ts's checkProviderBudget reads it back.
export async function PATCH(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const provider = parseCredentialProvider((await params).provider);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 404 });
  const body = await request.json().catch(() => null);
  const input = parseCredentialLimitInput(body);
  if (!input) return Response.json({ error: "Send { kind, monthlyLimitUsd }, a whole-dollar number or null" }, { status: 400 });
  if (!availableCredentialKinds(provider).includes(input.kind)) {
    return Response.json({ error: `${providerLabel(provider)} does not accept a subscription credential.` }, { status: 400 });
  }
  const monthlyLimitMicroUsd = input.monthlyLimitUsd === null ? null : Math.round(input.monthlyLimitUsd * 1_000_000);
  const credential = await setProviderCredentialLimit(user.id, provider, input.kind, monthlyLimitMicroUsd);
  if (!credential) return Response.json({ error: "That credential is not connected." }, { status: 404 });
  await notifyCredentialChange(user.id);
  return Response.json({ credential });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const provider = parseCredentialProvider((await params).provider);
  if (!provider) return Response.json({ error: "Unknown provider" }, { status: 404 });
  // ?kind= says which of the provider's rows to disconnect; omitting it keeps
  // the historical single-row behavior (api_key).
  const kind = parseCredentialKind(new URL(request.url).searchParams.get("kind") ?? "api_key");
  if (!kind || !credentialKindsForProvider(provider).includes(kind)) {
    return Response.json({ error: "Unknown credential kind" }, { status: 404 });
  }
  await deleteProviderCredential(user.id, provider, kind);
  await notifyCredentialChange(user.id);
  return new Response(null, { status: 204 });
}

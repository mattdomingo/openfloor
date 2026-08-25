import { getDb, type D1DatabaseLike } from "./index";
import type { CredentialKind, CredentialProvider, ProviderCredentialSummary } from "@/lib/provider-credentials";

type CredentialRow = {
  provider: CredentialProvider;
  kind: CredentialKind;
  fingerprint: string;
  validatedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

const SUMMARY_COLUMNS =
  "provider, kind, fingerprint, validated_at AS validatedAt, created_at AS createdAt, updated_at AS updatedAt";

export async function listProviderCredentials(
  userId: string,
  database: D1DatabaseLike = getDb(),
): Promise<ProviderCredentialSummary[]> {
  const rows = await database
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM user_provider_credentials WHERE user_id = ? ORDER BY provider`)
    .bind(userId)
    .all<CredentialRow>();
  return rows.results;
}

export type AutoAgentProviderResolution = {
  configuredProvider: CredentialProvider | null;
  effectiveProvider: CredentialProvider | null;
  state: "selected" | "single_connected" | "openai_fallback" | "selection_required";
};

/** Resolve generated-agent provider policy without exposing credential data. */
export async function resolveAutoAgentProvider(
  sessionId: string,
  database: D1DatabaseLike = getDb(),
  disabledProviders: ReadonlySet<CredentialProvider> = new Set(),
): Promise<AutoAgentProviderResolution> {
  const session = await database.prepare(
    `SELECT s.auto_agent_provider AS configuredProvider, owner.user_id AS ownerUserId
     FROM sessions s
     JOIN session_members owner ON owner.session_id = s.id AND owner.role = 'owner' AND owner.removed_at IS NULL
     WHERE s.id = ?`,
  ).bind(sessionId).first<{ configuredProvider: CredentialProvider | null; ownerUserId: string }>();
  if (!session) return { configuredProvider: null, effectiveProvider: null, state: "selection_required" };
  const credentials = await database.prepare(
    "SELECT provider FROM user_provider_credentials WHERE user_id = ? ORDER BY provider",
  ).bind(session.ownerUserId).all<{ provider: CredentialProvider }>();
  const enabledCredentials = credentials.results
    .map((credential) => credential.provider)
    .filter((provider) => !disabledProviders.has(provider));
  if (session.configuredProvider && enabledCredentials.includes(session.configuredProvider)) {
    return { configuredProvider: session.configuredProvider, effectiveProvider: session.configuredProvider, state: "selected" };
  }
  if (enabledCredentials.length === 0) {
    return { configuredProvider: null, effectiveProvider: "openai", state: "openai_fallback" };
  }
  if (enabledCredentials.length === 1) {
    return { configuredProvider: null, effectiveProvider: enabledCredentials[0], state: "single_connected" };
  }
  return { configuredProvider: null, effectiveProvider: null, state: "selection_required" };
}

export async function upsertProviderCredential(
  userId: string,
  provider: CredentialProvider,
  record: { kind: CredentialKind; ciphertext: string; fingerprint: string; validatedAt: number | null },
  database: D1DatabaseLike = getDb(),
): Promise<ProviderCredentialSummary> {
  const now = Date.now();
  await database
    .prepare(
      `INSERT INTO user_provider_credentials (user_id, provider, kind, ciphertext, fingerprint, validated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         kind = excluded.kind,
         ciphertext = excluded.ciphertext,
         fingerprint = excluded.fingerprint,
         validated_at = excluded.validated_at,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, provider, record.kind, record.ciphertext, record.fingerprint, record.validatedAt, now, now)
    .run();
  const row = await database
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM user_provider_credentials WHERE user_id = ? AND provider = ?`)
    .bind(userId, provider)
    .first<CredentialRow>();
  if (!row) throw new Error("Credential upsert did not persist.");
  return row;
}

export async function deleteProviderCredential(
  userId: string,
  provider: CredentialProvider,
  database: D1DatabaseLike = getDb(),
): Promise<boolean> {
  const result = await database
    .prepare("DELETE FROM user_provider_credentials WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

// Run-time resolution input: the run's agent owner's stored credential for
// one provider. Billing follows whoever owns the agent (the "Owner" chosen in
// the create-agent dialog), not the session owner — the person whose name is
// on the agent is the person whose key pays for its runs. removeMember
// transfers a removed member's agents to the removing owner, so billing
// follows the transfer; the removed_at guard here is defense-in-depth for
// any path that leaves a removed user owning an agent — such a key is never
// billed (null result, ladder falls to the server key / refusal).
// The ciphertext stays server-side; callers decrypt with the user+provider
// context (lib/credential-crypto.ts) and never return it.
export async function getRunAgentOwnerCredential(
  runId: string,
  provider: CredentialProvider,
  database: D1DatabaseLike = getDb(),
): Promise<{ ownerUserId: string; ciphertext: string } | null> {
  return await database
    .prepare(
      `SELECT fa.owner_user_id AS ownerUserId, c.ciphertext AS ciphertext
       FROM agent_runs r
       JOIN floor_agents fa ON fa.id = r.agent_id
       JOIN session_members sm ON sm.session_id = r.session_id AND sm.user_id = fa.owner_user_id AND sm.removed_at IS NULL
       JOIN user_provider_credentials c ON c.user_id = fa.owner_user_id AND c.provider = ?
       WHERE r.id = ?`,
    )
    .bind(provider, runId)
    .first<{ ownerUserId: string; ciphertext: string }>();
}

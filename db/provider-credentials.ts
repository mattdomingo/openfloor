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

// Run-time resolution input: the session owner's stored credential for one
// provider. The ciphertext stays server-side; callers decrypt with the
// user+provider context (lib/credential-crypto.ts) and never return it.
export async function getSessionOwnerCredential(
  sessionId: string,
  provider: CredentialProvider,
  database: D1DatabaseLike = getDb(),
): Promise<{ ownerUserId: string; ciphertext: string } | null> {
  return await database
    .prepare(
      `SELECT sm.user_id AS ownerUserId, c.ciphertext AS ciphertext
       FROM session_members sm
       JOIN user_provider_credentials c ON c.user_id = sm.user_id AND c.provider = ?
       WHERE sm.session_id = ? AND sm.role = 'owner' AND sm.removed_at IS NULL`,
    )
    .bind(provider, sessionId)
    .first<{ ownerUserId: string; ciphertext: string }>();
}

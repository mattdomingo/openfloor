import { getDb, type D1DatabaseLike } from "./index";
import { decryptCredential } from "@/lib/credential-crypto";
import {
  credentialAadContext,
  credentialKindLabel,
  credentialKindsForProvider,
  providerLabel,
  resolveRunCredentialSource,
  type CredentialKind,
  type CredentialProvider,
  type ProviderCredentialSummary,
} from "@/lib/provider-credentials";

type CredentialRow = {
  provider: CredentialProvider;
  kind: CredentialKind;
  fingerprint: string;
  validatedAt: number | null;
  createdAt: number;
  updatedAt: number;
  monthlyLimitMicroUsd: number | null;
  monthSpendMicroUsd: number;
};

// Joined to provider_spend_months for the current UTC month so every
// Settings row carries its own spend meter without a second round trip per
// row. c.kind never equals 'server' (that kind only appears on the
// server-fallback rollup, which has no matching credential row to join to),
// so this LEFT JOIN never double-counts across kinds.
const SUMMARY_COLUMNS =
  `c.provider, c.kind, c.fingerprint, c.validated_at AS validatedAt, c.created_at AS createdAt, c.updated_at AS updatedAt,
   c.monthly_limit_micro_usd AS monthlyLimitMicroUsd, COALESCE(spend.micro_usd, 0) AS monthSpendMicroUsd`;
const SUMMARY_JOIN =
  `LEFT JOIN provider_spend_months spend
     ON spend.user_id = c.user_id AND spend.provider = c.provider AND spend.kind = c.kind AND spend.month = ?`;

function currentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function listProviderCredentials(
  userId: string,
  database: D1DatabaseLike = getDb(),
): Promise<ProviderCredentialSummary[]> {
  const rows = await database
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM user_provider_credentials c ${SUMMARY_JOIN} WHERE c.user_id = ? ORDER BY c.provider, c.kind`)
    .bind(currentUtcMonth(), userId)
    .all<CredentialRow>();
  return rows.results;
}

export async function setProviderCredentialLimit(
  userId: string,
  provider: CredentialProvider,
  kind: CredentialKind,
  monthlyLimitMicroUsd: number | null,
  database: D1DatabaseLike = getDb(),
): Promise<ProviderCredentialSummary | null> {
  await database.prepare(
    "UPDATE user_provider_credentials SET monthly_limit_micro_usd = ?, updated_at = ? WHERE user_id = ? AND provider = ? AND kind = ?",
  ).bind(monthlyLimitMicroUsd, Date.now(), userId, provider, kind).run();
  const row = await database
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM user_provider_credentials c ${SUMMARY_JOIN} WHERE c.user_id = ? AND c.provider = ? AND c.kind = ?`)
    .bind(currentUtcMonth(), userId, provider, kind)
    .first<CredentialRow>();
  return row ?? null;
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
  // DISTINCT because a provider can hold two rows since credential kinds
  // became first-class (api_key + oauth) — one provider with both kinds is
  // still ONE connected provider, not a "selection required" pair.
  const credentials = await database.prepare(
    "SELECT DISTINCT provider FROM user_provider_credentials WHERE user_id = ? ORDER BY provider",
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
       ON CONFLICT(user_id, provider, kind) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         fingerprint = excluded.fingerprint,
         validated_at = excluded.validated_at,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, provider, record.kind, record.ciphertext, record.fingerprint, record.validatedAt, now, now)
    .run();
  const row = await database
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM user_provider_credentials c ${SUMMARY_JOIN} WHERE c.user_id = ? AND c.provider = ? AND c.kind = ?`)
    .bind(currentUtcMonth(), userId, provider, record.kind)
    .first<CredentialRow>();
  if (!row) throw new Error("Credential upsert did not persist.");
  return row;
}

export async function deleteProviderCredential(
  userId: string,
  provider: CredentialProvider,
  kind: CredentialKind,
  database: D1DatabaseLike = getDb(),
): Promise<boolean> {
  const result = await database
    .prepare("DELETE FROM user_provider_credentials WHERE user_id = ? AND provider = ? AND kind = ?")
    .bind(userId, provider, kind)
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
//
// The agent's credential_kind narrows the join: a named kind matches only its
// own row; null prefers api_key and otherwise takes whatever single row
// exists. `requestedKind` comes back even when no row matched, so callers can
// tell "owner has nothing" (server fallback allowed) from "owner has nothing
// OF THE KIND THIS AGENT ASKED FOR" (refuse — never bill a payer the agent
// did not name). The ciphertext stays server-side; callers decrypt with the
// kind-aware AAD (credentialAadContext) and never return it.
export async function getRunAgentOwnerCredential(
  runId: string,
  provider: CredentialProvider,
  database: D1DatabaseLike = getDb(),
): Promise<{
  ownerUserId: string;
  requestedKind: CredentialKind | null;
  kind: CredentialKind | null;
  ciphertext: string | null;
} | null> {
  return await database
    .prepare(
      `SELECT fa.owner_user_id AS ownerUserId, fa.credential_kind AS requestedKind,
              c.kind AS kind, c.ciphertext AS ciphertext
       FROM agent_runs r
       JOIN floor_agents fa ON fa.id = r.agent_id
       JOIN session_members sm ON sm.session_id = r.session_id AND sm.user_id = fa.owner_user_id AND sm.removed_at IS NULL
       LEFT JOIN user_provider_credentials c
         ON c.user_id = fa.owner_user_id AND c.provider = ?
        AND (fa.credential_kind IS NULL OR c.kind = fa.credential_kind)
       WHERE r.id = ?
       ORDER BY CASE WHEN c.kind = 'api_key' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .bind(provider, runId)
    .first<{ ownerUserId: string; requestedKind: CredentialKind | null; kind: CredentialKind | null; ciphertext: string | null }>();
}

export type ResolvedRunSecret =
  | { ok: true; source: "owner" | "server"; kind: CredentialKind; secret: string }
  | { ok: false; message: string };

// The one implementation of the per-run credential ladder, shared by every
// gateway route (anthropic-compat, openai, gemini) so a fix to this
// security-sensitive resolution never has to land N times. Decisions live in
// the pure resolveRunCredentialSource; this adds the D1 read, the
// kind-vs-provider enforcement, and the AAD-bound decrypt. Server fallback is
// always api_key by construction — bindings are plain strings, and openfloor
// never operates a subscription seat on anyone else's behalf.
export async function resolveRunProviderSecret(
  runId: string,
  provider: CredentialProvider,
  options: { serverKey: string | undefined; encryptionKey: string | undefined },
  database: D1DatabaseLike = getDb(),
): Promise<ResolvedRunSecret> {
  const owner = await getRunAgentOwnerCredential(runId, provider, database);
  const resolution = resolveRunCredentialSource({
    ownerCredentialPresent: Boolean(owner?.ciphertext),
    serverKeyPresent: Boolean(options.serverKey),
    missingSelectedKind: Boolean(owner && owner.ciphertext === null && owner.requestedKind !== null),
  });
  if (resolution.source === "owner" && owner?.ciphertext && owner.kind) {
    if (!credentialKindsForProvider(provider).includes(owner.kind)) {
      // A hand-written row of a kind this provider does not accept must never
      // reach the vendor — and must not fall through to the server key either
      // (that would silently switch payer).
      console.warn(`${provider} gateway refused credential kind ${owner.kind}: not allowed for this provider`);
      return { ok: false, message: `No ${providerLabel(provider)} credential is available for this run.` };
    }
    const decrypted = options.encryptionKey
      ? await decryptCredential(owner.ciphertext, options.encryptionKey, credentialAadContext(owner.ownerUserId, provider, owner.kind))
      : null;
    if (!decrypted) {
      return { ok: false, message: `The agent owner's connected ${providerLabel(provider)} credential could not be read. Reconnect it in Settings.` };
    }
    await recordBilledKind(runId, owner.kind, database);
    return { ok: true, source: "owner", kind: owner.kind, secret: decrypted };
  }
  if (resolution.source === "server" && options.serverKey) {
    await recordBilledKind(runId, "server", database);
    return { ok: true, source: "server", kind: "api_key", secret: options.serverKey };
  }
  if (resolution.source === "none" && resolution.reason === "missing_selected_kind" && owner?.requestedKind) {
    return {
      ok: false,
      message: `This agent is set to use your ${providerLabel(provider)} ${owner.requestedKind === "oauth" ? "subscription" : "API key"}, which is not connected. Connect it in Settings or change the agent.`,
    };
  }
  return { ok: false, message: `No ${providerLabel(provider)} credential is available for this run.` };
}

// One write per run, not one per model request: every gateway route
// (anthropic-compat, openai, gemini) calls resolveRunProviderSecret on every
// model call a run makes, but which credential paid never changes mid-run —
// the WHERE guard makes every call after the first a no-op. db/runs.ts's
// recordRunUsage reads this column at run completion to attribute spend to
// the right (user, provider, kind) rollup bucket.
async function recordBilledKind(runId: string, kind: CredentialKind | "server", database: D1DatabaseLike): Promise<void> {
  await database.prepare("UPDATE agent_runs SET billed_kind = ? WHERE id = ? AND billed_kind IS NULL")
    .bind(kind, runId).run();
}

// Same (ownerUserId, provider, credentialKind) shape as
// db/runs.ts's getQueueItemAgentBudgetContext — the conflict resolver path
// has an agentId directly (PendingConflict) rather than a queue item.
export async function getAgentBudgetContext(
  agentId: string,
  database: D1DatabaseLike = getDb(),
): Promise<{ ownerUserId: string; provider: CredentialProvider; credentialKind: CredentialKind | null } | null> {
  const row = await database.prepare(
    "SELECT owner_user_id AS ownerUserId, provider, credential_kind AS credentialKind FROM floor_agents WHERE id = ?",
  ).bind(agentId).first<{ ownerUserId: string; provider: CredentialProvider; credentialKind: CredentialKind | null }>();
  return row ?? null;
}

export type ProviderBudgetStatus = { ok: true } | { ok: false; message: string };

// Pre-run gate (lib/agent-run-start.ts): is the credential this run would
// bill already over its owner-set monthly cap? Mirrors
// getRunAgentOwnerCredential's kind-resolution ORDER BY (prefer api_key when
// the agent names no specific kind) so the row checked here is the same one
// resolveRunProviderSecret would actually charge. A server-key-fallback run
// is never limited: it only reaches "server" when the owner has no usable
// credential row at all, so this lookup naturally finds nothing to check.
export async function checkProviderBudget(
  ownerUserId: string,
  provider: CredentialProvider,
  requestedKind: CredentialKind | null,
  database: D1DatabaseLike = getDb(),
): Promise<ProviderBudgetStatus> {
  const credential = await database.prepare(
    `SELECT kind, monthly_limit_micro_usd AS limitMicroUsd FROM user_provider_credentials
     WHERE user_id = ? AND provider = ? AND (? IS NULL OR kind = ?)
     ORDER BY CASE WHEN kind = 'api_key' THEN 0 ELSE 1 END LIMIT 1`,
  ).bind(ownerUserId, provider, requestedKind, requestedKind).first<{ kind: CredentialKind; limitMicroUsd: number | null }>();
  if (!credential || credential.limitMicroUsd == null) return { ok: true };
  const month = new Date().toISOString().slice(0, 7);
  const spend = await database.prepare(
    "SELECT micro_usd AS microUsd FROM provider_spend_months WHERE user_id = ? AND provider = ? AND kind = ? AND month = ?",
  ).bind(ownerUserId, provider, credential.kind, month).first<{ microUsd: number }>();
  if ((spend?.microUsd ?? 0) >= credential.limitMicroUsd) {
    return {
      ok: false,
      message: `This agent's owner has reached their monthly ${providerLabel(provider)} ${credentialKindLabel(provider, credential.kind)} budget.`,
    };
  }
  return { ok: true };
}

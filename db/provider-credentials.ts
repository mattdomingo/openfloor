import { getDb, type D1DatabaseLike } from "./index";
import { decryptCredential, encryptCredential } from "@/lib/credential-crypto";
import {
  chatGptBundleNeedsRefresh,
  parseChatGptBundle,
  refreshChatGptBundle,
  type ChatGptBundle,
} from "@/lib/chatgpt-auth";
import {
  credentialAadContext,
  availableCredentialKinds,
  credentialKindLabel,
  providerLabel,
  resolveRunCredentialSource,
  type CredentialKind,
  type CredentialProvider,
  type MonthlyProviderUsage,
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
  monthInputTokens: number;
  monthOutputTokens: number;
};

// Joined to provider_spend_months for the current UTC month so every
// Settings row carries its own spend meter without a second round trip per
// row. c.kind never equals 'server' (that kind only appears on the
// server-fallback rollup, which has no matching credential row to join to),
// so this LEFT JOIN never double-counts across kinds.
const SUMMARY_COLUMNS =
  `c.provider, c.kind, c.fingerprint, c.validated_at AS validatedAt, c.created_at AS createdAt, c.updated_at AS updatedAt,
   c.monthly_limit_micro_usd AS monthlyLimitMicroUsd, COALESCE(spend.micro_usd, 0) AS monthSpendMicroUsd,
   COALESCE(spend.input_tokens, 0) AS monthInputTokens, COALESCE(spend.output_tokens, 0) AS monthOutputTokens`;
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

// Every rollup row for the current UTC month, including kind='server' rows
// (openfloor's fallback key), which have no credential row and are invisible
// to listProviderCredentials' join.
export async function getMonthlyModelUsage(
  userId: string,
  database: D1DatabaseLike = getDb(),
): Promise<MonthlyProviderUsage[]> {
  const rows = await database.prepare(
    `SELECT provider, kind, micro_usd AS microUsd, input_tokens AS inputTokens, output_tokens AS outputTokens
     FROM provider_spend_months WHERE user_id = ? AND month = ? ORDER BY provider, kind`,
  ).bind(userId, currentUtcMonth()).all<MonthlyProviderUsage>();
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
  state: "selected" | "single_connected" | "missing_key" | "selection_required" | "personal_disabled" | "default_unavailable";
  personalEnabled: boolean;
};

/** Resolve generated-agent provider policy without exposing credential data. */
export async function resolveAutoAgentProvider(
  sessionId: string,
  database: D1DatabaseLike = getDb(),
  disabledProviders: ReadonlySet<CredentialProvider> = new Set(),
  userId?: string,
): Promise<AutoAgentProviderResolution> {
  const member = await database.prepare(
    `SELECT u.default_api_provider AS configuredProvider, sm.user_id AS userId, sm.auto_agents_enabled AS enabled
     FROM session_members sm JOIN users u ON u.id = sm.user_id
     WHERE sm.session_id = ? AND sm.removed_at IS NULL AND (? IS NULL AND sm.role = 'owner' OR sm.user_id = ?)`,
  ).bind(sessionId, userId ?? null, userId ?? null).first<{ configuredProvider: CredentialProvider | null; userId: string; enabled: number }>();
  const result = { configuredProvider: member?.configuredProvider ?? null, effectiveProvider: null, personalEnabled: Boolean(member?.enabled) };
  if (!member?.enabled) return { ...result, state: "personal_disabled" };
  const credentials = await database.prepare("SELECT provider FROM user_provider_credentials WHERE user_id = ? AND kind = 'api_key'")
    .bind(member.userId).all<{ provider: CredentialProvider }>();
  const enabled = credentials.results.map((row) => row.provider).filter((provider) => !disabledProviders.has(provider));
  if (member.configuredProvider) return enabled.includes(member.configuredProvider)
    ? { ...result, effectiveProvider: member.configuredProvider, state: "selected" }
    : { ...result, state: "default_unavailable" };
  if (enabled.length === 0) return { ...result, state: "missing_key" };
  if (enabled.length === 1) return { ...result, effectiveProvider: enabled[0], state: "single_connected" };
  return { ...result, state: "selection_required" };
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

// Resolve only the original agent owner's API key while that owner remains
// a member. Leaving or removal preserves ownership and blocks future spending.
// requestedKind survives a missing credential so subscriptions refuse clearly.
// Ciphertext stays server-side and decrypts with kind-aware AAD.
export async function getRunAgentOwnerCredential(
  runId: string,
  provider: CredentialProvider,
  database: D1DatabaseLike = getDb(),
): Promise<{
  ownerUserId: string;
  requestedKind: CredentialKind | null;
  kind: CredentialKind | null;
  ciphertext: string | null;
  updatedAt: number | null;
} | null> {
  return await database
    .prepare(
      `SELECT fa.owner_user_id AS ownerUserId, fa.credential_kind AS requestedKind,
              c.kind AS kind, c.ciphertext AS ciphertext, c.updated_at AS updatedAt
       FROM agent_runs r
       JOIN floor_agents fa ON fa.id = r.agent_id
       JOIN session_members sm ON sm.session_id = r.session_id AND sm.user_id = fa.owner_user_id AND sm.removed_at IS NULL
       LEFT JOIN user_provider_credentials c
         ON c.user_id = fa.owner_user_id AND c.provider = ? AND c.kind = 'api_key'
        AND (fa.credential_kind IS NULL OR c.kind = fa.credential_kind)
       WHERE r.id = ?
       ORDER BY CASE WHEN c.kind = 'api_key' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .bind(provider, runId)
    .first<{ ownerUserId: string; requestedKind: CredentialKind | null; kind: CredentialKind | null; ciphertext: string | null; updatedAt: number | null }>();
}

// ownerUserId/updatedAt are present only on an owner resolution, and exist so a
// gateway can run the D6 conditional-update critical section against the exact
// row it just read. Server resolutions have no row to rotate.
export type ResolvedRunSecret =
  | { ok: true; source: "owner"; kind: CredentialKind; secret: string; ownerUserId?: string; updatedAt?: number }
  | { ok: false; message: string };

// The one implementation of the per-run credential ladder, shared by every
// gateway route (anthropic-compat, openai, gemini) so a fix to this
// security-sensitive resolution never has to land N times. Decisions live in
// the pure resolveRunCredentialSource; this adds the D1 read, the
// kind-vs-provider enforcement, and the AAD-bound decrypt. Platform secrets
// are ignored; legacy subscription records cannot authorize execution.
export async function resolveRunProviderSecret(
  runId: string,
  provider: CredentialProvider,
  options: { serverKey?: string; encryptionKey: string | undefined },
  database: D1DatabaseLike = getDb(),
): Promise<ResolvedRunSecret> {
  const owner = await getRunAgentOwnerCredential(runId, provider, database);
  if (owner?.requestedKind === "oauth") return { ok: false, message: "Subscription connections are unavailable. Select a connected API key in the agent settings." };
  const resolution = resolveRunCredentialSource({
    ownerCredentialPresent: Boolean(owner?.ciphertext),
    serverKeyPresent: Boolean(options.serverKey),
    missingSelectedKind: Boolean(owner && owner.ciphertext === null && owner.requestedKind !== null),
  });
  if (resolution.source === "owner" && owner?.ciphertext && owner.kind) {
    if (!availableCredentialKinds(provider).includes(owner.kind)) {
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
    return {
      ok: true,
      source: "owner",
      kind: owner.kind,
      secret: decrypted,
      ownerUserId: owner.ownerUserId,
      ...(owner.updatedAt === null ? {} : { updatedAt: owner.updatedAt }),
    };
  }
  if (resolution.source === "none" && resolution.reason === "missing_selected_kind" && owner?.requestedKind) {
    return {
      ok: false,
      message: `This agent is set to use your ${providerLabel(provider)} API key, which is not connected. Connect it in Settings or change the agent.`,
    };
  }
  return { ok: false, message: `No ${providerLabel(provider)} credential is available for this run.` };
}

/**
 * Keep a stored ChatGPT bundle usable, refreshing server-side when its access
 * token is close to expiring.
 *
 * This is the brief's D6 critical section, and it is a real requirement rather
 * than a theoretical one: the vendor ROTATES the refresh token on every
 * exchange (measured), so if two concurrent dispatches both refreshed, the
 * loser would persist a refresh token the winner had already invalidated and
 * every later run for that member would break. The guard is a conditional
 * update on the row's `updated_at` — one short write, never a whole-run lock —
 * and the loser simply re-reads the winner's result.
 *
 * The container is never involved: it holds no bundle, so there is nothing to
 * write back from a run. Refresh failure is deliberately NOT fatal — the
 * existing token is usually still valid, and a genuinely dead one fails at the
 * vendor with its own message rather than being masked here.
 */
export async function ensureFreshChatGptBundle(
  resolved: { secret: string; ownerUserId?: string; updatedAt?: number },
  options: { encryptionKey: string | undefined },
  database: D1DatabaseLike = getDb(),
  now: number = Date.now(),
): Promise<ChatGptBundle | null> {
  const bundle = parseChatGptBundle(resolved.secret);
  if (!bundle) return null;
  if (!chatGptBundleNeedsRefresh(bundle, now)) return bundle;
  if (!bundle.refreshToken || !resolved.ownerUserId || resolved.updatedAt === undefined || !options.encryptionKey) {
    return bundle;
  }
  const rotated = await refreshChatGptBundle(bundle);
  if (!rotated) return bundle;
  const ciphertext = await encryptCredential(
    rotated,
    options.encryptionKey,
    credentialAadContext(resolved.ownerUserId, "openai", "oauth"),
  );
  // Date.now() can collide for concurrent refreshes. A strictly increasing
  // version keeps compare-and-set single-winner even within one millisecond.
  const refreshedAt = Math.max(now, resolved.updatedAt + 1);
  const update = await database
    .prepare(
      `UPDATE user_provider_credentials SET ciphertext = ?, updated_at = ?
        WHERE user_id = ? AND provider = 'openai' AND kind = 'oauth' AND updated_at = ?`,
    )
    .bind(ciphertext, refreshedAt, resolved.ownerUserId, resolved.updatedAt)
    .run();
  if ((update.meta?.changes ?? 0) > 0) return parseChatGptBundle(rotated) ?? bundle;
  // Lost the race. The winner already stored a bundle built from the same
  // refresh token, so re-read theirs instead of using ours: only one of the two
  // rotations is the one the vendor will still honour next time.
  const row = await database
    .prepare("SELECT ciphertext FROM user_provider_credentials WHERE user_id = ? AND provider = 'openai' AND kind = 'oauth'")
    .bind(resolved.ownerUserId)
    .first<{ ciphertext: string }>();
  if (!row) return bundle;
  const winner = await decryptCredential(
    row.ciphertext,
    options.encryptionKey,
    credentialAadContext(resolved.ownerUserId, "openai", "oauth"),
  );
  return (winner && parseChatGptBundle(winner)) || bundle;
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

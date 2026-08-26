// ChatGPT-subscription auth bundle handling for the openai runtime gateway.
// Pure helpers plus the one refresh call; no cloudflare:workers import, so
// unit tests reach this directly (same rule as lib/plans.ts).
//
// Spike D (2026-08-26) established the shape this file encodes:
//   - The Codex CLI forwards its bearer OPAQUELY. openfloor therefore never
//     puts a ChatGPT credential in the container: the run keeps sending its
//     run-scoped JWT and only this gateway knows the difference, exactly as
//     the anthropic gateway already does for a Claude setup token.
//   - A subscription bearer is only accepted at chatgpt.com/backend-api/codex.
//     Sending it to api.openai.com/v1/responses returns 401 (measured), so the
//     upstream switches with the credential kind, not just the header.
//   - Refresh is 401/expiry-driven, NOT `last_refresh`-age-driven. A 12-day-old
//     last_refresh with a live access token refreshes nothing. So the decision
//     below keys on the access token's own `exp`.

// OpenAI's own public Codex CLI client id, read out of the pinned binary. It is
// a public client identifier, not a secret: this is the same client the
// member's own `codex login` uses, which is why refreshing a credential they
// minted themselves is not openfloor operating an OAuth client of its own.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

// Refresh once the access token is within a day of expiring. The vendor issues
// 240-hour tokens, so this fires roughly once per member per ten days and can
// never leave a 90-minute run holding a credential that dies mid-flight.
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

export type ChatGptBundle = {
  accessToken: string;
  accountId: string;
  refreshToken: string | null;
  /** The whole parsed bundle, so unknown vendor fields round-trip on refresh. */
  document: Record<string, unknown>;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a stored bundle. Mirrors parseCredentialConnectInput's shape check —
 * a stored row that no longer satisfies it must refuse, never be sent onward.
 */
export function parseChatGptBundle(secret: string): ChatGptBundle | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const document = parsed as Record<string, unknown>;
  const tokens = document.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const { access_token: accessToken, account_id: accountId, refresh_token: refreshToken } =
    tokens as { access_token?: unknown; account_id?: unknown; refresh_token?: unknown };
  if (typeof accessToken !== "string" || !accessToken) return null;
  if (typeof accountId !== "string" || !accountId) return null;
  return {
    accessToken,
    accountId,
    refreshToken: typeof refreshToken === "string" && refreshToken ? refreshToken : null,
    document,
  };
}

/** Epoch milliseconds at which the bundle's access token expires, if readable. */
export function chatGptTokenExpiry(accessToken: string): number | null {
  const payload = decodeJwtPayload(accessToken);
  return payload && typeof payload.exp === "number" ? payload.exp * 1000 : null;
}

/**
 * An unreadable expiry is treated as "refresh": a token whose exp cannot be
 * read is one we cannot promise will outlive the run.
 */
export function chatGptBundleNeedsRefresh(bundle: ChatGptBundle, now: number): boolean {
  const expiry = chatGptTokenExpiry(bundle.accessToken);
  return expiry === null || expiry - now <= REFRESH_MARGIN_MS;
}

/**
 * Exchange the refresh token for a new bundle, preserving every unknown field.
 * Returns the serialized bundle to store, or null when the vendor refuses —
 * callers keep using the existing token rather than failing a run that a still
 * valid credential could have served.
 */
export async function refreshChatGptBundle(bundle: ChatGptBundle): Promise<string | null> {
  if (!bundle.refreshToken) return null;
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: bundle.refreshToken,
        scope: "openid profile email",
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { access_token: accessToken, refresh_token: refreshToken, id_token: idToken } =
    payload as { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
  if (typeof accessToken !== "string" || !accessToken) return null;
  const tokens: Record<string, unknown> = {
    ...(bundle.document.tokens as Record<string, unknown>),
    access_token: accessToken,
  };
  // The vendor rotates the refresh token, so a partial write would strand the
  // member on a dead one. Only fields it actually returned are replaced.
  if (typeof refreshToken === "string" && refreshToken) tokens.refresh_token = refreshToken;
  if (typeof idToken === "string" && idToken) tokens.id_token = idToken;
  return JSON.stringify({ ...bundle.document, tokens, last_refresh: new Date().toISOString() });
}

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type AuthenticatedIdentity = {
  providerUserId: string;
  email: string;
  displayName: string;
  fullName: string | null;
};

export type IdentityEnvironment = {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  OPENFLOOR_DEV_USER_ID?: string;
  OPENFLOOR_DEV_USER_EMAIL?: string;
  OPENFLOOR_DEV_USER_NAME?: string;
  OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string;
};

// Cloudflare Access issues a different `sub` per identity provider (Google
// vs. a one-time email code), so email is the only stable signal a returning
// user carries across login methods. `db/sessions.ts:upsertUser` and the
// `idx_users_email` unique index both depend on every identity constructor
// here producing the same canonical form for the same mailbox — lowercase,
// trimmed — or "sign in a different way" silently creates a second account.
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const TRUSTED_USER_ID_HEADER = "x-openfloor-authenticated-user-id";
const TRUSTED_USER_EMAIL_HEADER = "x-openfloor-authenticated-user-email";
const TRUSTED_USER_NAME_HEADER = "x-openfloor-authenticated-user-name";
const DEV_USER_ID_HEADER = "x-openfloor-dev-user-id";
const DEV_USER_EMAIL_HEADER = "x-openfloor-dev-user-email";
const DEV_USER_NAME_HEADER = "x-openfloor-dev-user-name";
const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function cloudflareAccessIdentity(
  headers: Headers,
  environment: IdentityEnvironment,
): Promise<AuthenticatedIdentity | null> {
  const token = headers.get(ACCESS_JWT_HEADER)?.trim();
  const teamDomain = normalizedTeamDomain(environment.CF_ACCESS_TEAM_DOMAIN);
  const audience = parseAudienceList(environment.CF_ACCESS_AUD);
  if (!token || !teamDomain || !audience) return null;

  try {
    const jwksUrl = `${teamDomain}/cdn-cgi/access/certs`;
    let keySet = remoteKeySets.get(jwksUrl);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(jwksUrl));
      remoteKeySets.set(jwksUrl, keySet);
    }
    const { payload } = await jwtVerify(token, keySet, {
      issuer: teamDomain,
      audience,
    });
    return identityFromVerifiedAccessClaims(payload);
  } catch {
    return null;
  }
}

export function identityFromVerifiedAccessClaims(payload: JWTPayload): AuthenticatedIdentity | null {
  const subject = payload.sub?.trim();
  const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : "";
  if (!subject || !email) return null;
  const fullName = typeof payload.name === "string" ? payload.name.trim() || null : null;
  return {
    providerUserId: `cloudflare-access:${subject}`,
    email,
    fullName,
    displayName: fullName?.trim() || email,
  };
}

// These headers are internal to the Worker-to-application handoff. The Worker
// always deletes client-provided values before setting verified identity.
export function identityFromTrustedHeaders(headers: Headers): AuthenticatedIdentity | null {
  const providerUserId = headers.get(TRUSTED_USER_ID_HEADER)?.trim();
  const rawEmail = headers.get(TRUSTED_USER_EMAIL_HEADER)?.trim();
  if (!providerUserId || !rawEmail) return null;
  const email = normalizeEmail(rawEmail);
  const fullName = headers.get(TRUSTED_USER_NAME_HEADER)?.trim() || null;
  return { providerUserId, email, fullName, displayName: fullName || email };
}

export function requestWithTrustedIdentity(
  request: Request,
  identity: AuthenticatedIdentity | null,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(TRUSTED_USER_ID_HEADER);
  headers.delete(TRUSTED_USER_EMAIL_HEADER);
  headers.delete(TRUSTED_USER_NAME_HEADER);
  if (identity) {
    headers.set(TRUSTED_USER_ID_HEADER, identity.providerUserId);
    headers.set(TRUSTED_USER_EMAIL_HEADER, identity.email);
    if (identity.fullName) headers.set(TRUSTED_USER_NAME_HEADER, identity.fullName);
  }
  return new Request(request, { headers });
}

export function localDevelopmentIdentity(
  headers: Headers,
  environment: IdentityEnvironment = process.env as IdentityEnvironment,
): AuthenticatedIdentity | null {
  const host = (headers.get("host") || headers.get("x-forwarded-host"))?.split(":")[0];
  const isLoopback = host === "localhost" || host === "127.0.0.1";
  const allowTestHeaders = environment.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true";
  if (!isLoopback && !allowTestHeaders) return null;

  const providerUserId = (allowTestHeaders ? headers.get(DEV_USER_ID_HEADER) : null)?.trim()
    || (isLoopback ? environment.OPENFLOOR_DEV_USER_ID?.trim() : null);
  const rawEmail = (allowTestHeaders ? headers.get(DEV_USER_EMAIL_HEADER) : null)?.trim()
    || (isLoopback ? environment.OPENFLOOR_DEV_USER_EMAIL?.trim() : null);
  if (!providerUserId || !rawEmail) return null;
  const email = normalizeEmail(rawEmail);

  const fullName = ((allowTestHeaders ? headers.get(DEV_USER_NAME_HEADER) : null)
    || (isLoopback ? environment.OPENFLOOR_DEV_USER_NAME : null))?.trim() || null;
  return { providerUserId, email, fullName, displayName: fullName || email };
}

// Exported so app/signout/route.ts can validate CF_ACCESS_TEAM_DOMAIN with the
// same rule before building the team-domain logout URL.
export function normalizedTeamDomain(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Production splits the protected paths across two self-hosted Access
// applications on the same hostname (five-destination cap per app — see
// AGENTS.md "Authentication and identity"), so a page request and its first
// /api call can carry JWTs minted for two different AUD tags. Whether one
// hostname's CF_Authorization cookie merges both apps' tags into a single
// token's aud array is undocumented by Cloudflare, so this trusts either tag
// explicitly rather than depending on that. CF_ACCESS_AUD is a comma-
// separated list; a single value (today's secret) keeps working unchanged.
function parseAudienceList(value: string | undefined): string[] | null {
  const audiences = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return audiences.length > 0 ? audiences : null;
}

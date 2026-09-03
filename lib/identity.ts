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
  const teamDomain = normalizedTeamDomain(environment.CF_ACCESS_TEAM_DOMAIN);
  const audience = parseAudienceList(environment.CF_ACCESS_AUD);
  if (!teamDomain || !audience) return null;

  // The injected header only exists on paths Access itself gates. Page paths
  // are deliberately outside Access (so signed-out visitors reach our own
  // /signin instead of the hosted login screen), so the same JWT is read
  // from the CF_Authorization cookie the auth flow set — and verified with
  // the identical signature/issuer/audience checks, which is the entire
  // trust the header carried.
  const headerToken = headers.get(ACCESS_JWT_HEADER)?.trim();
  const candidates = headerToken ? [headerToken] : accessCookieTokens(headers.get("cookie"));
  if (candidates.length === 0) return null;

  const jwksUrl = `${teamDomain}/cdn-cgi/access/certs`;
  let keySet = remoteKeySets.get(jwksUrl);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(jwksUrl));
    remoteKeySets.set(jwksUrl, keySet);
  }
  for (const token of candidates) {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: teamDomain,
        audience,
      });
      const identity = identityFromVerifiedAccessClaims(payload);
      if (identity) return identity;
    } catch {
      // An expired or foreign-audience token; try the next candidate.
    }
  }
  return null;
}

// A request can carry several CF_Authorization cookies (the team domain and
// path-scoped app copies); every value is a candidate until one verifies.
function accessCookieTokens(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const tokens: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== "CF_Authorization") continue;
    const value = part.slice(separator + 1).trim();
    if (value) tokens.push(value);
  }
  return tokens;
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

// Production currently uses one Access application and one audience. Keep the
// parser tolerant of a comma-separated list so an audience can be rotated, or
// a deployment can temporarily split destinations across applications,
// without an authentication outage.
function parseAudienceList(value: string | undefined): string[] | null {
  const audiences = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return audiences.length > 0 ? audiences : null;
}

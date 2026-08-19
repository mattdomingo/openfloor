export type AuthenticatedIdentity = {
  providerUserId: string;
  email: string;
  displayName: string;
  fullName: string | null;
};

const USER_ID_HEADER = "oai-authenticated-user-id";
const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";

export function identityFromHeaders(headers: Headers): AuthenticatedIdentity | null {
  const providerUserId = headers.get(USER_ID_HEADER)?.trim();
  const email = headers.get(USER_EMAIL_HEADER)?.trim();
  if (!providerUserId || !email) return null;

  const encodedName = headers.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedName && headers.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedName)
      : null;

  return {
    providerUserId,
    email,
    fullName,
    displayName: fullName?.trim() || email,
  };
}

export function localDevelopmentIdentity(headers: Headers): AuthenticatedIdentity | null {
  const host = headers.get("host")?.split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") return null;

  const providerUserId = process.env.OPENFLOOR_DEV_USER_ID?.trim();
  const email = process.env.OPENFLOOR_DEV_USER_EMAIL?.trim();
  if (!providerUserId || !email) return null;

  const fullName = process.env.OPENFLOOR_DEV_USER_NAME?.trim() || null;
  return { providerUserId, email, fullName, displayName: fullName || email };
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

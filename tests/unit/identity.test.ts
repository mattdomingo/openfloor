import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cloudflareAccessIdentity,
  identityFromVerifiedAccessClaims,
  identityFromTrustedHeaders,
  localDevelopmentIdentity,
  requestWithTrustedIdentity,
} from "@/lib/identity";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare Access identity", () => {
  it("requires a verified subject and email", () => {
    expect(identityFromVerifiedAccessClaims({ email: "person@example.com" })).toBeNull();
    expect(identityFromVerifiedAccessClaims({ sub: "access-user" })).toBeNull();
    expect(identityFromVerifiedAccessClaims({ sub: "access-user", email: "person@example.com", name: "Renée Smith" }))
      .toEqual({
        providerUserId: "cloudflare-access:access-user",
        email: "person@example.com",
        fullName: "Renée Smith",
        displayName: "Renée Smith",
      });
  });

  it("validates the Access JWT signature, issuer, and audience", async () => {
    const teamDomain = "https://openfloor-unit-test.cloudflareaccess.com";
    const audience = "openfloor-test-audience";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    Object.assign(publicJwk, { kid: "test-key", alg: "RS256", use: "sig" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [publicJwk] })));

    const validToken = await new SignJWT({ email: "owner@example.com", name: "Owner Example" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(teamDomain)
      .setAudience(audience)
      .setSubject("access-owner")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(cloudflareAccessIdentity(
      new Headers({ "cf-access-jwt-assertion": validToken }),
      { CF_ACCESS_TEAM_DOMAIN: teamDomain, CF_ACCESS_AUD: audience },
    )).resolves.toMatchObject({
      providerUserId: "cloudflare-access:access-owner",
      displayName: "Owner Example",
    });

    await expect(cloudflareAccessIdentity(
      new Headers({ "cf-access-jwt-assertion": validToken }),
      { CF_ACCESS_TEAM_DOMAIN: teamDomain, CF_ACCESS_AUD: "wrong-audience" },
    )).resolves.toBeNull();
  });

  it("does not trust identity metadata without a JWT", async () => {
    await expect(cloudflareAccessIdentity(
      new Headers({ "cf-access-authenticated-user-email": "person@example.com" }),
      {
        CF_ACCESS_TEAM_DOMAIN: "https://openfloor-unit-test.cloudflareaccess.com",
        CF_ACCESS_AUD: "audience",
      },
    )).resolves.toBeNull();
  });

  it("replaces spoofed internal headers at the Worker handoff", () => {
    const spoofed = new Request("https://opnflr.com/app/home", { headers: {
      "x-openfloor-authenticated-user-id": "attacker",
      "x-openfloor-authenticated-user-email": "attacker@example.com",
    } });
    expect(identityFromTrustedHeaders(requestWithTrustedIdentity(spoofed, null).headers)).toBeNull();
    expect(identityFromTrustedHeaders(requestWithTrustedIdentity(spoofed, {
      providerUserId: "cloudflare-access:verified",
      email: "verified@example.com",
      fullName: "Verified User",
      displayName: "Verified User",
    }).headers)).toMatchObject({
      providerUserId: "cloudflare-access:verified",
      email: "verified@example.com",
    });
  });
});

describe("email normalization", () => {
  const mixedCase = "  Matt@Opnflr.COM  ";
  const expected = "matt@opnflr.com";

  it("identityFromVerifiedAccessClaims lowercases and trims the email claim, leaving fullName untouched", () => {
    const identity = identityFromVerifiedAccessClaims({ sub: "access-user", email: mixedCase, name: "  Matt  " });
    expect(identity?.email).toBe(expected);
    expect(identity?.fullName).toBe("Matt");
  });

  it("falls back displayName to the normalized email when there is no name claim", () => {
    const identity = identityFromVerifiedAccessClaims({ sub: "access-user", email: mixedCase });
    expect(identity?.fullName).toBeNull();
    expect(identity?.displayName).toBe(expected);
  });

  it("identityFromTrustedHeaders lowercases and trims the internal email header", () => {
    const headers = new Headers({
      "x-openfloor-authenticated-user-id": "trusted-id",
      "x-openfloor-authenticated-user-email": mixedCase,
    });
    expect(identityFromTrustedHeaders(headers)?.email).toBe(expected);
  });

  it("localDevelopmentIdentity lowercases and trims the dev/test email", () => {
    const headers = new Headers({
      host: "127.0.0.1:8787",
      "x-openfloor-dev-user-id": "dev-id",
      "x-openfloor-dev-user-email": mixedCase,
    });
    expect(localDevelopmentIdentity(headers, { OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true" })?.email).toBe(expected);
  });

  // Table-driven on purpose: a fourth identity constructor added later that
  // forgets to normalize would silently reopen the duplicate-account bug
  // (db/sessions.ts:upsertUser and idx_users_email both assume every
  // constructor here produces the same canonical form for the same mailbox).
  it("normalizes identically across every identity constructor", () => {
    const results = [
      identityFromVerifiedAccessClaims({ sub: "s", email: mixedCase })?.email,
      identityFromTrustedHeaders(new Headers({
        "x-openfloor-authenticated-user-id": "id",
        "x-openfloor-authenticated-user-email": mixedCase,
      }))?.email,
      localDevelopmentIdentity(new Headers({
        host: "127.0.0.1",
        "x-openfloor-dev-user-id": "id",
        "x-openfloor-dev-user-email": mixedCase,
      }), { OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true" })?.email,
    ];
    expect(results).toEqual([expected, expected, expected]);
  });
});

describe("development identity isolation", () => {
  it("uses explicit local variables only on loopback", () => {
    const environment = {
      OPENFLOOR_DEV_USER_ID: "local-user",
      OPENFLOOR_DEV_USER_EMAIL: "local@example.com",
      OPENFLOOR_DEV_USER_NAME: "Local Person",
    };
    expect(localDevelopmentIdentity(new Headers({ host: "opnflr.com" }), environment)).toBeNull();
    expect(localDevelopmentIdentity(new Headers({ host: "localhost:3000" }), environment)).toMatchObject({
      providerUserId: "local-user",
      displayName: "Local Person",
    });
    expect(localDevelopmentIdentity(new Headers({ "x-forwarded-host": "127.0.0.1:8787" }), environment))
      .toMatchObject({ providerUserId: "local-user" });
  });

  it("allows per-context test identities only with the explicit test gate", () => {
    const headers = new Headers({
      host: "127.0.0.1:8787",
      "x-openfloor-dev-user-id": "test-user",
      "x-openfloor-dev-user-email": "test@example.com",
    });
    expect(localDevelopmentIdentity(headers, {})).toBeNull();
    expect(localDevelopmentIdentity(headers, { OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true" }))
      .toMatchObject({ providerUserId: "test-user", email: "test@example.com" });
    headers.set("host", "opnflr.com");
    expect(localDevelopmentIdentity(headers, {})).toBeNull();
    expect(localDevelopmentIdentity(headers, { OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true" }))
      .toMatchObject({ providerUserId: "test-user" });
  });
});

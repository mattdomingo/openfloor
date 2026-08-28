import { env } from "cloudflare:workers";

export type D1Prepared = {
  bind(...values: unknown[]): D1Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
};

export type D1ResultLike = { success: boolean; meta?: { changes?: number } };

export type D1DatabaseLike = {
  prepare(query: string): D1Prepared;
  batch(statements: D1Prepared[]): Promise<D1ResultLike[]>;
};

export function getDb(): D1DatabaseLike {
  const database = (env as unknown as { DB?: D1DatabaseLike }).DB;
  if (!database) {
    throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  }
  return database;
}

export function getInviteSigningSecret(): string {
  const secret = (env as unknown as { INVITE_SIGNING_SECRET?: string }).INVITE_SIGNING_SECRET;
  if (!secret) throw new Error("`INVITE_SIGNING_SECRET` is unavailable.");
  return secret;
}

export function getCredentialEncryptionSecret(): string {
  const secret = (env as unknown as { CREDENTIAL_ENCRYPTION_KEY?: string }).CREDENTIAL_ENCRYPTION_KEY;
  if (!secret) throw new Error("`CREDENTIAL_ENCRYPTION_KEY` is unavailable.");
  return secret;
}

// Deterministic connect-time key validation for tests (same convention as
// OPENFLOOR_TEST_GITHUB_DATA): JSON of provider -> accepted keys, honored only
// when the test flag is on. Production always validates against the provider.
export function getTestProviderKeys(): Partial<Record<import("@/lib/provider-credentials").CredentialProvider, string[]>> | null {
  const bindings = env as unknown as Record<string, string | undefined>;
  if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS !== "true") return null;
  const value = bindings.OPENFLOOR_TEST_PROVIDER_KEYS;
  if (!value) return null;
  try {
    return JSON.parse(value) as Partial<Record<import("@/lib/provider-credentials").CredentialProvider, string[]>>;
  } catch {
    throw new Error("`OPENFLOOR_TEST_PROVIDER_KEYS` is invalid JSON.");
  }
}

export function getGitHubAppConfig(): import("@/lib/github").GitHubAppConfig {
  const bindings = env as unknown as Record<string, string | undefined>;
  const testEnabled = bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true";
  const testDataValue = testEnabled ? bindings.OPENFLOOR_TEST_GITHUB_DATA : undefined;
  let testData: import("@/lib/github").GitHubAppConfig["testData"] = null;
  if (testDataValue) {
    try {
      testData = JSON.parse(testDataValue) as import("@/lib/github").GitHubAppConfig["testData"];
    } catch {
      throw new Error("`OPENFLOOR_TEST_GITHUB_DATA` is invalid JSON.");
    }
  }
  const config = {
    appId: bindings.GITHUB_APP_ID ?? "",
    clientId: bindings.GITHUB_APP_CLIENT_ID ?? "",
    clientSecret: bindings.GITHUB_CLIENT_SECRET ?? "",
    privateKey: bindings.GITHUB_APP_PRIVATE_KEY ?? "",
    slug: bindings.GITHUB_APP_SLUG ?? "",
    stateSecret: bindings.GITHUB_STATE_SECRET ?? "",
    webhookSecret: bindings.GITHUB_WEBHOOK_SECRET ?? "",
    testData,
  };
  if (!config.stateSecret) throw new Error("`GITHUB_STATE_SECRET` is unavailable.");
  if (!config.webhookSecret) throw new Error("`GITHUB_WEBHOOK_SECRET` is unavailable.");
  if (!testData && (!config.appId || !config.privateKey || !config.slug)) {
    throw new Error("GitHub App bindings are unavailable.");
  }
  return config;
}

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

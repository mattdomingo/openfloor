import { env } from "cloudflare:workers";

export type D1Prepared = {
  bind(...values: unknown[]): D1Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
};

export type D1DatabaseLike = {
  prepare(query: string): D1Prepared;
  batch(statements: D1Prepared[]): Promise<unknown[]>;
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

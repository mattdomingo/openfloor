import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSession, upsertUser } from "@/db/sessions";
import { sweepStorageCleanup } from "@/worker/storage-cleanup";

describe("durable private-storage cleanup", () => {
  it("deletes every object under a queued prefix and requires two empty scans", async () => {
    const prefix = `runs/security-cleanup-${crypto.randomUUID()}/`;
    const objects = new Set([`${prefix}prompt.txt`, `${prefix}session-store.tgz`]);
    const bucket = {
      async list({ prefix: requested = "" }: { prefix?: string } = {}) {
        return { objects: [...objects].filter((key) => key.startsWith(requested)).map((key) => ({ key })), truncated: false };
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
    };
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO storage_cleanup_prefixes (bucket, prefix, source_session_id, not_before, updated_at) VALUES ('preflight_logs', ?, NULL, ?, ?)",
    ).bind(prefix, now, now).run();

    const cleanupEnv = { DB: env.DB, PREFLIGHT_LOGS: bucket, USER_AVATARS: bucket };
    await sweepStorageCleanup(cleanupEnv);
    expect(objects.size).toBe(0);

    await env.DB.prepare("UPDATE storage_cleanup_prefixes SET not_before = 0 WHERE prefix = ?").bind(prefix).run();
    await sweepStorageCleanup(cleanupEnv);
    expect((await env.DB.prepare("SELECT empty_scans AS emptyScans FROM storage_cleanup_prefixes WHERE prefix = ?").bind(prefix).first<{ emptyScans: number }>())?.emptyScans).toBe(1);

    await env.DB.prepare("UPDATE storage_cleanup_prefixes SET not_before = 0 WHERE prefix = ?").bind(prefix).run();
    await sweepStorageCleanup(cleanupEnv);
    expect(await env.DB.prepare("SELECT 1 AS present FROM storage_cleanup_prefixes WHERE prefix = ?").bind(prefix).first()).toBeNull();
  });

  it("skips a queued prefix while its source session still exists", async () => {
    const now = Date.now();
    const user = await upsertUser({
      providerUserId: `cleanup-${crypto.randomUUID()}`,
      email: `${crypto.randomUUID()}@example.com`,
      displayName: "Cleanup owner",
      fullName: "Cleanup owner",
    }, env.DB);
    const created = await createSession(user.id, { title: "Cleanup source", objective: null }, env.DB);
    const sessionId = created.session.id;
    const prefix = `sessions/${sessionId}/`;
    await env.DB.prepare(
      "INSERT INTO storage_cleanup_prefixes (bucket, prefix, source_session_id, not_before, updated_at) VALUES ('preflight_logs', ?, ?, 0, ?)",
    ).bind(prefix, sessionId, now).run();
    let listCalls = 0;
    const bucket = {
      async list() { listCalls += 1; return { objects: [], truncated: false }; },
      async delete() {},
    };

    await sweepStorageCleanup({ DB: env.DB, PREFLIGHT_LOGS: bucket, USER_AVATARS: bucket });

    expect(listCalls).toBe(0);
    const deferred = await env.DB.prepare(
      "SELECT not_before AS notBefore FROM storage_cleanup_prefixes WHERE prefix = ?",
    ).bind(prefix).first<{ notBefore: number }>();
    expect(deferred?.notBefore).toBeGreaterThan(now);
  });

  it("defers a full window of live-session jobs so later cleanup cannot starve", async () => {
    const now = Date.now();
    const user = await upsertUser({
      providerUserId: `cleanup-starvation-${crypto.randomUUID()}`,
      email: `${crypto.randomUUID()}@example.com`,
      displayName: "Cleanup starvation owner",
      fullName: "Cleanup starvation owner",
    }, env.DB);
    const created = await createSession(user.id, { title: "Cleanup starvation source", objective: null }, env.DB);
    const livePrefixes = Array.from({ length: 25 }, (_, index) => `sessions/${created.session.id}/held-${index}/`);
    const healthyPrefix = `runs/security-after-live-window-${crypto.randomUUID()}/`;
    await env.DB.batch([
      ...livePrefixes.map((prefix) => env.DB.prepare(
        "INSERT INTO storage_cleanup_prefixes (bucket, prefix, source_session_id, not_before, updated_at) VALUES ('preflight_logs', ?, ?, 0, ?)",
      ).bind(prefix, created.session.id, now - 1_000)),
      env.DB.prepare(
        "INSERT INTO storage_cleanup_prefixes (bucket, prefix, source_session_id, not_before, updated_at) VALUES ('preflight_logs', ?, NULL, 0, ?)",
      ).bind(healthyPrefix, now - 500),
    ]);
    const objects = new Set([`${healthyPrefix}artifact.log`]);
    const bucket = {
      async list({ prefix = "" }: { prefix?: string } = {}) {
        return { objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
    };
    const cleanupEnv = { DB: env.DB, PREFLIGHT_LOGS: bucket, USER_AVATARS: bucket };

    await sweepStorageCleanup(cleanupEnv);
    expect(objects.size).toBe(1);
    await sweepStorageCleanup(cleanupEnv);
    expect(objects.size).toBe(0);
  });

  it("paginates deletion and keeps a failed job for retry without blocking another", async () => {
    const failingPrefix = `runs/security-failing-${crypto.randomUUID()}/`;
    const healthyPrefix = `runs/security-paginated-${crypto.randomUUID()}/`;
    const objects = new Set(Array.from({ length: 1_005 }, (_, index) => `${healthyPrefix}${index}.log`));
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO storage_cleanup_prefixes (bucket, prefix, source_session_id, not_before, updated_at) VALUES ('preflight_logs', ?, NULL, 0, ?)",
      ).bind(failingPrefix, now - 1),
      env.DB.prepare(
        "INSERT INTO storage_cleanup_prefixes (bucket, prefix, source_session_id, not_before, updated_at) VALUES ('preflight_logs', ?, NULL, 0, ?)",
      ).bind(healthyPrefix, now),
    ]);
    const bucket = {
      async list({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) {
        if (prefix === failingPrefix) throw new Error("simulated R2 failure");
        const matches = [...objects].filter((key) => key.startsWith(prefix ?? ""));
        const offset = cursor ? Number(cursor) : 0;
        const page = matches.slice(offset, offset + 1_000);
        const nextOffset = offset + page.length;
        return { objects: page.map((key) => ({ key })), truncated: nextOffset < matches.length, cursor: String(nextOffset) };
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
    };

    await sweepStorageCleanup({ DB: env.DB, PREFLIGHT_LOGS: bucket, USER_AVATARS: bucket });

    expect(objects.size).toBe(0);
    const failed = await env.DB.prepare(
      "SELECT not_before AS notBefore FROM storage_cleanup_prefixes WHERE prefix = ?",
    ).bind(failingPrefix).first<{ notBefore: number }>();
    expect(failed?.notBefore).toBeGreaterThan(now);
    expect(await env.DB.prepare("SELECT 1 AS present FROM storage_cleanup_prefixes WHERE prefix = ?").bind(healthyPrefix).first()).not.toBeNull();
  });
});

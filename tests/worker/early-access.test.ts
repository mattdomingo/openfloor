import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  grantEarlyAccess,
  listPendingWaitlistSync,
  manuallyRestoreEarlyAccess,
  purgeExpiredWaitlist,
  revokeEarlyAccess,
  syncWaitlistRecordToSheet,
  upsertWaitlistEntry,
} from "@/db/early-access";
import { upsertUser } from "@/db/sessions";
import { EARLY_ACCESS_RETENTION_MS } from "@/lib/early-access";

describe("early-access D1 state", () => {
  it("upserts duplicate normalized emails without changing the record id", async () => {
    const first = await upsertWaitlistEntry({ name: "Ada", email: "ada@example.com", consentVersion: "v1" }, env.DB, 100);
    const second = await upsertWaitlistEntry({ name: "Ada Lovelace", email: "ada@example.com", consentVersion: "v2" }, env.DB, 200);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ name: "Ada Lovelace", consentVersion: "v2", consentedAt: 200, sheetSyncState: "pending" });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM early_access_waitlist WHERE email = ?")
      .bind("ada@example.com").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("makes new users unadmitted, keeps revocation sticky, and allows only manual restoration", async () => {
    const user = await upsertUser({
      providerUserId: "early-access-user",
      email: "beta@example.com",
      displayName: "Beta User",
      fullName: "Beta User",
    }, env.DB);
    expect(user.earlyAccessGrantedAt).toBeNull();
    await upsertWaitlistEntry({ name: "Beta User", email: user.email, consentVersion: "v1" }, env.DB, 100);

    await expect(grantEarlyAccess(user.id, "passcode", env.DB, 200)).resolves.toBe(true);
    await expect(revokeEarlyAccess(user.id, env.DB, 300)).resolves.toBe(true);
    await expect(grantEarlyAccess(user.id, "passcode", env.DB, 400)).resolves.toBe(false);
    await expect(manuallyRestoreEarlyAccess(user.id, env.DB, 500)).resolves.toBe(true);

    const state = await env.DB.prepare(
      "SELECT early_access_granted_at AS grantedAt, early_access_revoked_at AS revokedAt, early_access_grant_source AS source FROM users WHERE id = ?",
    ).bind(user.id).first<{ grantedAt: number; revokedAt: number | null; source: string }>();
    expect(state).toEqual({ grantedAt: 500, revokedAt: null, source: "manual" });
    const waitlist = await env.DB.prepare("SELECT status, sheet_sync_state AS syncState FROM early_access_waitlist WHERE email = ?")
      .bind(user.email).first<{ status: string; syncState: string }>();
    expect(waitlist).toEqual({ status: "admitted", syncState: "pending" });
  });

  it("keeps Sheet failures pending and retries the same record idempotently", async () => {
    const record = await upsertWaitlistEntry({ name: "Grace", email: "grace@example.com", consentVersion: "v1" }, env.DB, 1_000);
    const payloads: Array<{ id: string }> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as { payload: string };
      payloads.push(JSON.parse(envelope.payload) as { id: string });
      return payloads.length === 1
        ? new Response(JSON.stringify({ ok: false }))
        : new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const bindings = { WAITLIST_SHEET_WEBHOOK_URL: "https://script.google.test/exec", WAITLIST_SHEET_WEBHOOK_SECRET: "secret" };

    await expect(syncWaitlistRecordToSheet(record, env.DB, bindings, fetcher, 2_000)).resolves.toBe(false);
    const pending = (await listPendingWaitlistSync(env.DB, 62_000)).find((candidate) => candidate.id === record.id);
    expect(pending).toBeDefined();
    expect(pending).toMatchObject({ id: record.id, sheetSyncAttempts: 1, sheetSyncState: "pending" });
    await expect(syncWaitlistRecordToSheet(pending!, env.DB, bindings, fetcher, 62_000)).resolves.toBe(true);
    expect(payloads.map(({ id }) => id)).toEqual([record.id, record.id]);
    const synced = await env.DB.prepare("SELECT sheet_sync_state AS state FROM early_access_waitlist WHERE id = ?")
      .bind(record.id).first<{ state: string }>();
    expect(synced?.state).toBe("synced");
  });

  it("purges records 12 months after their last update", async () => {
    await upsertWaitlistEntry({ name: "Old", email: "old@example.com", consentVersion: "v1" }, env.DB, 1_000);
    await upsertWaitlistEntry({ name: "Current", email: "current@example.com", consentVersion: "v1" }, env.DB, EARLY_ACCESS_RETENTION_MS + 2_000);
    await expect(purgeExpiredWaitlist(env.DB, EARLY_ACCESS_RETENTION_MS + 1_001)).resolves.toBeGreaterThanOrEqual(1);
    const old = await env.DB.prepare("SELECT id FROM early_access_waitlist WHERE email = 'old@example.com'").first();
    const current = await env.DB.prepare("SELECT id FROM early_access_waitlist WHERE email = 'current@example.com'").first();
    expect(old).toBeNull();
    expect(current).not.toBeNull();
  });
});

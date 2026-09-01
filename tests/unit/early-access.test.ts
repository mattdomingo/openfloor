import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EARLY_ACCESS_PENDING_TTL_MS,
  hasEarlyAccess,
  signPendingEarlyAccess,
  signWaitlistSheetPayload,
  verifyEarlyAccessPasscode,
  verifyPendingEarlyAccess,
} from "@/lib/early-access";

describe("early-access credentials", () => {
  it("compares the configured passcode without accepting blanks or prefixes", async () => {
    await expect(verifyEarlyAccessPasscode("beta-owl-47", "beta-owl-47")).resolves.toBe(true);
    await expect(verifyEarlyAccessPasscode("beta-owl", "beta-owl-47")).resolves.toBe(false);
    await expect(verifyEarlyAccessPasscode("", "beta-owl-47")).resolves.toBe(false);
    await expect(verifyEarlyAccessPasscode("beta-owl-47", undefined)).resolves.toBe(false);
  });

  it("accepts only an untampered pending-admission token inside its 15-minute window", async () => {
    const issuedAt = 1_900_000_000_000;
    const token = await signPendingEarlyAccess("cookie-secret", issuedAt);
    await expect(verifyPendingEarlyAccess(token, "cookie-secret", issuedAt + EARLY_ACCESS_PENDING_TTL_MS - 1)).resolves.toBe(true);
    await expect(verifyPendingEarlyAccess(token, "cookie-secret", issuedAt + EARLY_ACCESS_PENDING_TTL_MS + 1)).resolves.toBe(false);
    await expect(verifyPendingEarlyAccess(`${token.slice(0, -1)}x`, "cookie-secret", issuedAt + 1)).resolves.toBe(false);
    await expect(verifyPendingEarlyAccess(token, "different-secret", issuedAt + 1)).resolves.toBe(false);
  });

  it("requires a grant with no revocation", () => {
    expect(hasEarlyAccess({ earlyAccessGrantedAt: 1, earlyAccessRevokedAt: null })).toBe(true);
    expect(hasEarlyAccess({ earlyAccessGrantedAt: null, earlyAccessRevokedAt: null })).toBe(false);
    expect(hasEarlyAccess({ earlyAccessGrantedAt: 1, earlyAccessRevokedAt: 2 })).toBe(false);
  });

  it("signs the exact timestamp and payload expected by Apps Script", async () => {
    const payload = JSON.stringify({ id: "record-1", email: "ada@example.com" });
    const timestamp = 1_900_000_000_000;
    const expected = createHmac("sha256", "sheet-secret").update(`${timestamp}.${payload}`).digest("hex");
    await expect(signWaitlistSheetPayload("sheet-secret", timestamp, payload)).resolves.toBe(expected);
  });
});

describe("0044 early-access migration", () => {
  it("is additive and admits existing non-deleted accounts", () => {
    const file = readdirSync(new URL("../../drizzle", import.meta.url)).find((name) => name.startsWith("0044_") && name.endsWith(".sql"));
    expect(file).toBeTruthy();
    const sql = readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), "utf8");
    expect(sql).toContain("ALTER TABLE `users` ADD `early_access_granted_at`");
    expect(sql).toContain("`early_access_grant_source` = 'existing'");
    expect(sql).toContain("WHERE `deleted_at` IS NULL");
    expect(sql).not.toMatch(/DROP TABLE.*users|CREATE TABLE [`\"]?__new_users/i);
  });
});

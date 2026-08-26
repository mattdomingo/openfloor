import { describe, expect, it, vi } from "vitest";
import {
  chatGptBundleNeedsRefresh,
  chatGptTokenExpiry,
  parseChatGptBundle,
  refreshChatGptBundle,
} from "@/lib/chatgpt-auth";

function token(expiresInSeconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.sig`;
}

function bundle(accessToken: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    vendor_field_we_do_not_know: "must round-trip",
    tokens: { account_id: "acct-1", access_token: accessToken, refresh_token: "rt-1", id_token: "id-1" },
    ...extra,
  }, null, 2);
}

describe("ChatGPT auth bundles", () => {
  it("reads a pretty-printed bundle and refuses anything that is not one", () => {
    const parsed = parseChatGptBundle(bundle(token(3600)));
    expect(parsed?.accountId).toBe("acct-1");
    expect(parsed?.refreshToken).toBe("rt-1");
    // Mirrors parseCredentialConnectInput: a stored row that no longer has a
    // usable shape must refuse, never be forwarded.
    expect(parseChatGptBundle("{ not json")).toBeNull();
    expect(parseChatGptBundle("[1,2]")).toBeNull();
    expect(parseChatGptBundle(JSON.stringify({ tokens: {} }))).toBeNull();
    expect(parseChatGptBundle(JSON.stringify({ tokens: { account_id: "a" } }))).toBeNull();
    // A bundle with no refresh token still parses — it just cannot rotate.
    expect(parseChatGptBundle(JSON.stringify({ tokens: { account_id: "a", access_token: "b" } }))?.refreshToken).toBeNull();
  });

  it("keys refresh on the token's own expiry, never on file age", () => {
    const now = Date.now();
    // The vendor issues 240-hour tokens; a fresh one must not be refreshed
    // even when last_refresh is ancient (Spike D: file age triggers nothing).
    const fresh = parseChatGptBundle(bundle(token(240 * 3600), { last_refresh: "2020-01-01T00:00:00Z" }))!;
    expect(chatGptBundleNeedsRefresh(fresh, now)).toBe(false);
    // Inside the margin, and already expired, both refresh.
    expect(chatGptBundleNeedsRefresh(parseChatGptBundle(bundle(token(3600)))!, now)).toBe(true);
    expect(chatGptBundleNeedsRefresh(parseChatGptBundle(bundle(token(-3600)))!, now)).toBe(true);
    // An unreadable expiry cannot be promised to outlive the run, so refresh.
    expect(chatGptBundleNeedsRefresh(parseChatGptBundle(bundle("not-a-jwt"))!, now)).toBe(true);
    expect(chatGptTokenExpiry("not-a-jwt")).toBeNull();
  });

  it("rotates through the vendor's public Codex client, preserving unknown fields", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        access_token: "new-access", refresh_token: "new-refresh", id_token: "new-id", expires_in: 864000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const rotated = await refreshChatGptBundle(parseChatGptBundle(bundle(token(60)))!);
    expect(calls[0].url).toBe("https://auth.openai.com/oauth/token");
    expect(calls[0].body.grant_type).toBe("refresh_token");
    expect(calls[0].body.refresh_token).toBe("rt-1");
    const next = JSON.parse(rotated!) as Record<string, unknown>;
    const tokens = next.tokens as Record<string, unknown>;
    expect(tokens.access_token).toBe("new-access");
    // The vendor rotates the refresh token; persisting the old one would
    // strand the member on a credential it has already invalidated.
    expect(tokens.refresh_token).toBe("new-refresh");
    expect(tokens.account_id).toBe("acct-1");
    expect(next.vendor_field_we_do_not_know).toBe("must round-trip");
    expect(typeof next.last_refresh).toBe("string");
  });

  it("returns null rather than failing a run when the vendor refuses or is unreachable", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 400 }));
    expect(await refreshChatGptBundle(parseChatGptBundle(bundle(token(60)))!)).toBeNull();
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    expect(await refreshChatGptBundle(parseChatGptBundle(bundle(token(60)))!)).toBeNull();
    // No refresh token means nothing to exchange.
    const noRefresh = parseChatGptBundle(JSON.stringify({ tokens: { account_id: "a", access_token: "b" } }))!;
    expect(await refreshChatGptBundle(noRefresh)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  parseMcpServerCreateInput,
  parseMcpServerUpdateInput,
  serializeMcpServersForClaude,
} from "@/lib/mcp-config";

const VALID = { name: "issue-tracker", transport: "http", url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer token-1" } };

describe("mcp server create validation", () => {
  it("accepts a bounded https server and defaults enabled", () => {
    const parsed = parseMcpServerCreateInput(VALID);
    expect(parsed).toEqual({ ...VALID, enabled: true });
    expect(parseMcpServerCreateInput({ ...VALID, headers: undefined })).toEqual({ ...VALID, headers: null, enabled: true });
    expect(parseMcpServerCreateInput({ ...VALID, enabled: false })?.enabled).toBe(false);
  });

  it("rejects the reserved openfloor name and non-slug names", () => {
    expect(parseMcpServerCreateInput({ ...VALID, name: "openfloor" })).toBeNull();
    for (const name of ["UPPER", "a b", "a/b", "../up", "", "x".repeat(65)]) {
      expect(parseMcpServerCreateInput({ ...VALID, name })).toBeNull();
    }
  });

  it("rejects non-https, unparseable, and oversized urls", () => {
    expect(parseMcpServerCreateInput({ ...VALID, url: "http://mcp.example.com" })).toBeNull();
    expect(parseMcpServerCreateInput({ ...VALID, url: "not a url" })).toBeNull();
    expect(parseMcpServerCreateInput({ ...VALID, url: `https://x.example/${"a".repeat(2050)}` })).toBeNull();
  });

  it("bounds headers and rejects malformed names and values", () => {
    expect(parseMcpServerCreateInput({ ...VALID, headers: { "Bad Header": "v" } })).toBeNull();
    expect(parseMcpServerCreateInput({ ...VALID, headers: { "X-Ok": "line1\nline2" } })).toBeNull();
    expect(parseMcpServerCreateInput({ ...VALID, headers: { "X-Ok": "" } })).toBeNull();
    expect(parseMcpServerCreateInput({ ...VALID, headers: { "X-Ok": 5 } })).toBeNull();
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`X-H${index}`, "v"]));
    expect(parseMcpServerCreateInput({ ...VALID, headers: tooMany })).toBeNull();
    // Empty headers object normalizes to null.
    expect(parseMcpServerCreateInput({ ...VALID, headers: {} })?.headers).toBeNull();
  });
});

describe("mcp server update validation", () => {
  it("keeps omitted fields, clears headers on null, and rejects empty updates", () => {
    expect(parseMcpServerUpdateInput({ enabled: false })).toEqual({ enabled: false });
    expect(parseMcpServerUpdateInput({ headers: null })).toEqual({ headers: null });
    expect(parseMcpServerUpdateInput({ url: "https://next.example.com" })).toEqual({ url: "https://next.example.com" });
    expect(parseMcpServerUpdateInput({})).toBeNull();
    expect(parseMcpServerUpdateInput({ url: "http://insecure.example.com" })).toBeNull();
    expect(parseMcpServerUpdateInput({ transport: "stdio" })).toBeNull();
  });
});

describe("claude serialization", () => {
  it("emits the SDK's {type, url, headers} shape and strips the reserved name", () => {
    const serialized = serializeMcpServersForClaude([
      { name: "issue-tracker", transport: "http", url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer token-1" } },
      { name: "docs", transport: "sse", url: "https://docs.example.com/sse", headers: null },
      { name: "openfloor", transport: "http", url: "https://evil.example.com", headers: null },
    ]);
    expect(serialized).toEqual({
      "issue-tracker": { type: "http", url: "https://mcp.example.com/v1", headers: { Authorization: "Bearer token-1" } },
      docs: { type: "sse", url: "https://docs.example.com/sse" },
    });
  });
});

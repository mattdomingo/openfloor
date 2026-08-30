import ipaddr from "ipaddr.js";

// Session-configured MCP servers: shared internal types, bounded validation,
// and per-provider serialization. Pure module (no cloudflare:workers).
//
// The internal shape is deliberately provider-neutral: the Claude Agent SDK
// takes options.mcpServers keyed by name ({type, url, headers}), and the
// Codex SDK takes config.mcp_servers — verified against the pinned
// codex-cli 0.148.0 binary as [mcp_servers.<name>] url/http_headers over
// streamable_http (no sse equivalent). Its serializer lands with the Codex
// parity work. Do not shape this module's types around either provider.

export const RESERVED_MCP_SERVER_NAMES = new Set(["openfloor"]);
export const MAX_MCP_SERVERS_PER_SESSION = 10;
export const MAX_MCP_URL_CHARS = 2_048;
export const MAX_MCP_HEADER_COUNT = 16;
export const MAX_MCP_HEADER_NAME_CHARS = 128;
export const MAX_MCP_HEADER_VALUE_CHARS = 2_048;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

export type McpTransport = "http" | "sse";

// What a run actually consumes: decrypted headers included. Never leaves the
// server/workflow/runner boundary — API reads expose header NAMES only.
export type McpServerRuntimeConfig = {
  name: string;
  transport: McpTransport;
  url: string;
  headers: Record<string, string> | null;
};

export type McpServerCreateInput = {
  name: string;
  transport: McpTransport;
  url: string;
  headers: Record<string, string> | null;
  enabled: boolean;
};

// Update semantics mirror updateProfile's avatar argument: a field omitted is
// "keep", headers: null is "clear".
export type McpServerUpdateInput = {
  transport?: McpTransport;
  url?: string;
  headers?: Record<string, string> | null;
  enabled?: boolean;
};

function parseTransport(value: unknown): McpTransport | null {
  return value === "http" || value === "sse" ? value : null;
}

function parseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url || url.length > MAX_MCP_URL_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Remote servers only, over TLS — headers may carry credentials. Restrict
  // to the default TLS port and globally routable literal IPs; this prevents
  // obvious SSRF into loopback, link-local, and cloud metadata services.
  if (parsed.protocol !== "https:" || (parsed.port !== "" && parsed.port !== "443")) return null;
  if (parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
  if (ipaddr.isValid(hostname)) {
    const address = ipaddr.parse(hostname);
    if (address.kind() === "ipv4" && address.range() !== "unicast") return null;
    if (address.kind() === "ipv6" && address.range() !== "unicast") return null;
  }
  return url;
}

export function isSafeMcpUrl(url: string): boolean {
  return parseUrl(url) !== null;
}

function parseHeaders(value: unknown): Record<string, string> | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (entries.length > MAX_MCP_HEADER_COUNT) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME_PATTERN.test(name) || name.length > MAX_MCP_HEADER_NAME_CHARS) return undefined;
    if (typeof headerValue !== "string" || !headerValue || headerValue.length > MAX_MCP_HEADER_VALUE_CHARS) return undefined;
    if (/[\p{Cc}]/u.test(headerValue)) return undefined;
    headers[name] = headerValue;
  }
  return headers;
}

export function parseMcpServerCreateInput(value: unknown): McpServerCreateInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!NAME_PATTERN.test(name) || RESERVED_MCP_SERVER_NAMES.has(name)) return null;
  const transport = parseTransport(input.transport);
  const url = parseUrl(input.url);
  if (!transport || !url) return null;
  const headers = parseHeaders(input.headers);
  if (headers === undefined && input.headers !== undefined) return null;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return null;
  return { name, transport, url, headers: headers ?? null, enabled: input.enabled !== false };
}

export function parseMcpServerUpdateInput(value: unknown): McpServerUpdateInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const update: McpServerUpdateInput = {};
  if (input.transport !== undefined) {
    const transport = parseTransport(input.transport);
    if (!transport) return null;
    update.transport = transport;
  }
  if (input.url !== undefined) {
    const url = parseUrl(input.url);
    if (!url) return null;
    update.url = url;
  }
  if (input.headers !== undefined) {
    const headers = parseHeaders(input.headers);
    if (headers === undefined && input.headers !== null) return null;
    update.headers = headers ?? null;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return null;
    update.enabled = input.enabled;
  }
  if (Object.keys(update).length === 0) return null;
  return update;
}

// Claude Agent SDK options.mcpServers entries (McpHttpServerConfig /
// McpSSEServerConfig in the SDK's types: {type, url, headers?}).
export function serializeMcpServersForClaude(
  servers: McpServerRuntimeConfig[],
): Record<string, { type: McpTransport; url: string; headers?: Record<string, string> }> {
  const result: Record<string, { type: McpTransport; url: string; headers?: Record<string, string> }> = {};
  for (const server of servers) {
    if (RESERVED_MCP_SERVER_NAMES.has(server.name)) continue;
    result[server.name] = {
      type: server.transport,
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    };
  }
  return result;
}

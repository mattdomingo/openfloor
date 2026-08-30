import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createSessionMcpServer,
  deleteSessionMcpServer,
  getEnabledMcpServersForRun,
  listSessionMcpServersForMember,
  McpServerConflictError,
  McpServerLimitError,
  updateSessionMcpServer,
} from "@/db/mcp-servers";
import { acceptInvite, createSession, upsertUser } from "@/db/sessions";
import { MAX_MCP_SERVERS_PER_SESSION, parseMcpServerCreateInput } from "@/lib/mcp-config";

const SECRET = "worker-test-credential-encryption-key";

function identity(id: string, name: string) {
  return { providerUserId: `mcp-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

function serverInput(name: string, extra: Record<string, unknown> = {}) {
  const parsed = parseMcpServerCreateInput({
    name,
    transport: "http",
    url: `https://${name}.example.com/mcp`,
    headers: { Authorization: `Bearer secret-for-${name}` },
    ...extra,
  });
  if (!parsed) throw new Error("Invalid test server");
  return parsed;
}

async function room(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const outsider = await upsertUser(identity(`${suffix}-outsider`, "Outsider Example"), env.DB);
  const created = await createSession(owner.id, { title: `MCP ${suffix}`, objective: null }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  return { sessionId: created.session.id, owner, member, outsider };
}

describe("session MCP server persistence", () => {
  it("rejects internal, credential-bearing, and nonstandard-port endpoints", () => {
    for (const url of [
      "http://public.example.com/mcp",
      "https://localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://[::1]/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://user:password@public.example.com/mcp",
      "https://public.example.com:8443/mcp",
    ]) {
      expect(parseMcpServerCreateInput({ name: "blocked", transport: "http", url }), url).toBeNull();
    }
  });

  it("owner configures; members read names only; header values are encrypted at rest", async () => {
    const { sessionId, owner, member, outsider } = await room("crud");
    const created = await createSessionMcpServer(sessionId, owner.id, serverInput("issue-tracker"), SECRET, env.DB);
    expect(created).toHaveLength(1);
    expect(created?.[0]).toEqual(expect.objectContaining({
      name: "issue-tracker",
      transport: "http",
      enabled: true,
      headerNames: ["Authorization"],
    }));
    expect(JSON.stringify(created)).not.toContain("secret-for-issue-tracker");

    const stored = await env.DB.prepare("SELECT headers_ciphertext AS ciphertext FROM session_mcp_servers WHERE session_id = ?")
      .bind(sessionId)
      .first<{ ciphertext: string }>();
    expect(stored?.ciphertext).toBeTruthy();
    expect(stored?.ciphertext).not.toContain("secret-for-issue-tracker");

    expect(await listSessionMcpServersForMember(sessionId, member.id, env.DB)).toHaveLength(1);
    expect(await listSessionMcpServersForMember(sessionId, outsider.id, env.DB)).toBeNull();
    expect(await createSessionMcpServer(sessionId, member.id, serverInput("member-server"), SECRET, env.DB)).toBeNull();

    await expect(createSessionMcpServer(sessionId, owner.id, serverInput("issue-tracker"), SECRET, env.DB))
      .rejects.toBeInstanceOf(McpServerConflictError);
  });

  it("runs receive decrypted headers for enabled servers only, and fail loudly on unreadable ones", async () => {
    const { sessionId, owner } = await room("run");
    await createSessionMcpServer(sessionId, owner.id, serverInput("enabled-server"), SECRET, env.DB);
    const withDisabled = await createSessionMcpServer(sessionId, owner.id, serverInput("disabled-server", { enabled: false }), SECRET, env.DB);
    expect(withDisabled).toHaveLength(2);

    const runtime = await getEnabledMcpServersForRun(sessionId, SECRET, env.DB);
    expect(runtime).toHaveLength(1);
    expect(runtime[0].name).toBe("enabled-server");
    expect(runtime[0].headers).toEqual({ Authorization: "Bearer secret-for-enabled-server" });

    await expect(getEnabledMcpServersForRun(sessionId, "a-rotated-secret", env.DB)).rejects.toThrow(/could not be read/);
    await env.DB.prepare("UPDATE session_mcp_servers SET url = 'https://127.0.0.1/mcp' WHERE session_id = ? AND name = 'enabled-server'")
      .bind(sessionId).run();
    await expect(getEnabledMcpServersForRun(sessionId, SECRET, env.DB)).rejects.toThrow(/blocked URL/);
  });

  it("updates keep omitted fields, clear headers on null, and toggle enabled", async () => {
    const { sessionId, owner } = await room("update");
    const created = await createSessionMcpServer(sessionId, owner.id, serverInput("tools"), SECRET, env.DB);
    const serverId = created![0].id;

    const toggled = await updateSessionMcpServer(sessionId, owner.id, serverId, { enabled: false }, SECRET, env.DB);
    expect(toggled?.[0]).toEqual(expect.objectContaining({ enabled: false, headerNames: ["Authorization"] }));
    expect(await getEnabledMcpServersForRun(sessionId, SECRET, env.DB)).toHaveLength(0);

    const cleared = await updateSessionMcpServer(sessionId, owner.id, serverId, { headers: null, enabled: true }, SECRET, env.DB);
    expect(cleared?.[0]).toEqual(expect.objectContaining({ enabled: true, headerNames: [] }));
    const runtime = await getEnabledMcpServersForRun(sessionId, SECRET, env.DB);
    expect(runtime[0].headers).toBeNull();

    expect(await updateSessionMcpServer(sessionId, owner.id, crypto.randomUUID(), { enabled: true }, SECRET, env.DB)).toBeNull();

    const removed = await deleteSessionMcpServer(sessionId, owner.id, serverId, env.DB);
    expect(removed).toHaveLength(0);
  });

  it("enforces the per-session server cap", async () => {
    const { sessionId, owner } = await room("cap");
    for (let index = 0; index < MAX_MCP_SERVERS_PER_SESSION; index += 1) {
      await createSessionMcpServer(sessionId, owner.id, serverInput(`server-${index}`), SECRET, env.DB);
    }
    await expect(createSessionMcpServer(sessionId, owner.id, serverInput("one-too-many"), SECRET, env.DB))
      .rejects.toBeInstanceOf(McpServerLimitError);
  });
});

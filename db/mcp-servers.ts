import { decryptCredential, encryptCredential } from "@/lib/credential-crypto";
import {
  MAX_MCP_SERVERS_PER_SESSION,
  type McpServerCreateInput,
  type McpServerRuntimeConfig,
  type McpServerUpdateInput,
  type McpTransport,
} from "@/lib/mcp-config";
import { getDb, type D1DatabaseLike } from "./index";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";

export class McpServerLimitError extends Error {}
export class McpServerConflictError extends Error {}

export type SessionMcpServerSummary = {
  id: string;
  name: string;
  transport: McpTransport;
  url: string;
  headerNames: string[];
  enabled: boolean;
  updatedAt: number;
};

type ServerRow = {
  id: string;
  name: string;
  transport: McpTransport;
  url: string;
  headerNames: string | null;
  enabled: number;
  updatedAt: number;
};

const SUMMARY_COLUMNS = "id, name, transport, url, header_names AS headerNames, enabled, updated_at AS updatedAt";

function toSummary(row: ServerRow): SessionMcpServerSummary {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    headerNames: row.headerNames ? (JSON.parse(row.headerNames) as string[]) : [],
    enabled: Boolean(row.enabled),
    updatedAt: row.updatedAt,
  };
}

// Members read summaries (header names, never values); only the owner
// mutates; non-members get null → 404 concealment.
export async function listSessionMcpServersForMember(
  sessionId: string,
  userId: string,
  database: D1DatabaseLike = getDb(),
): Promise<SessionMcpServerSummary[] | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const rows = await database
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM session_mcp_servers WHERE session_id = ? ORDER BY name`)
    .bind(sessionId)
    .all<ServerRow>();
  return rows.results.map(toSummary);
}

export async function createSessionMcpServer(
  sessionId: string,
  userId: string,
  input: McpServerCreateInput,
  encryptionSecret: string,
  database: D1DatabaseLike = getDb(),
): Promise<SessionMcpServerSummary[] | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const count = await database
    .prepare("SELECT COUNT(*) AS count FROM session_mcp_servers WHERE session_id = ?")
    .bind(sessionId)
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_MCP_SERVERS_PER_SESSION) {
    throw new McpServerLimitError(`A session can hold at most ${MAX_MCP_SERVERS_PER_SESSION} MCP servers.`);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const headersCiphertext = input.headers ? await encryptCredential(JSON.stringify(input.headers), encryptionSecret, `mcp:${id}`) : null;
  const headerNames = input.headers ? JSON.stringify(Object.keys(input.headers)) : null;
  try {
    await database
      .prepare(
        `INSERT INTO session_mcp_servers (id, session_id, name, transport, url, headers_ciphertext, header_names, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, sessionId, input.name, input.transport, input.url, headersCiphertext, headerNames, input.enabled ? 1 : 0, userId, now, now)
      .run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new McpServerConflictError("An MCP server with that name already exists in this session.");
    }
    throw error;
  }
  return listSessionMcpServersForMember(sessionId, userId, database);
}

export async function updateSessionMcpServer(
  sessionId: string,
  userId: string,
  serverId: string,
  update: McpServerUpdateInput,
  encryptionSecret: string,
  database: D1DatabaseLike = getDb(),
): Promise<SessionMcpServerSummary[] | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const existing = await database
    .prepare("SELECT id FROM session_mcp_servers WHERE session_id = ? AND id = ?")
    .bind(sessionId, serverId)
    .first<{ id: string }>();
  if (!existing) return null;
  const now = Date.now();
  const statements = [
    database
      .prepare(
        `UPDATE session_mcp_servers SET
           transport = COALESCE(?, transport),
           url = COALESCE(?, url),
           enabled = COALESCE(?, enabled),
           updated_at = ?
         WHERE session_id = ? AND id = ?`,
      )
      .bind(update.transport ?? null, update.url ?? null, update.enabled === undefined ? null : update.enabled ? 1 : 0, now, sessionId, serverId),
  ];
  if (update.headers !== undefined) {
    const headersCiphertext = update.headers ? await encryptCredential(JSON.stringify(update.headers), encryptionSecret, `mcp:${serverId}`) : null;
    const headerNames = update.headers ? JSON.stringify(Object.keys(update.headers)) : null;
    statements.push(
      database
        .prepare("UPDATE session_mcp_servers SET headers_ciphertext = ?, header_names = ?, updated_at = ? WHERE session_id = ? AND id = ?")
        .bind(headersCiphertext, headerNames, now, sessionId, serverId),
    );
  }
  await database.batch(statements);
  return listSessionMcpServersForMember(sessionId, userId, database);
}

export async function deleteSessionMcpServer(
  sessionId: string,
  userId: string,
  serverId: string,
  database: D1DatabaseLike = getDb(),
): Promise<SessionMcpServerSummary[] | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  await database.prepare("DELETE FROM session_mcp_servers WHERE session_id = ? AND id = ?").bind(sessionId, serverId).run();
  return listSessionMcpServersForMember(sessionId, userId, database);
}

// Enabled servers with decrypted headers, for run dispatch. A row whose
// headers cannot be decrypted (e.g. after a CREDENTIAL_ENCRYPTION_KEY
// rotation) fails the run loudly rather than connecting without auth or
// silently dropping the server.
export async function getEnabledMcpServersForRun(
  sessionId: string,
  encryptionSecret: string,
  database: D1DatabaseLike = getDb(),
): Promise<McpServerRuntimeConfig[]> {
  const rows = await database
    .prepare("SELECT id, name, transport, url, headers_ciphertext AS headersCiphertext FROM session_mcp_servers WHERE session_id = ? AND enabled = 1 ORDER BY name")
    .bind(sessionId)
    .all<{ id: string; name: string; transport: McpTransport; url: string; headersCiphertext: string | null }>();
  const servers: McpServerRuntimeConfig[] = [];
  for (const row of rows.results) {
    let headers: Record<string, string> | null = null;
    if (row.headersCiphertext) {
      const decrypted = await decryptCredential(row.headersCiphertext, encryptionSecret, `mcp:${row.id}`);
      if (decrypted === null) {
        throw new Error(`MCP server "${row.name}" headers could not be read. Re-enter them in the session lobby.`);
      }
      headers = JSON.parse(decrypted) as Record<string, string>;
    }
    servers.push({ name: row.name, transport: row.transport, url: row.url, headers });
  }
  return servers;
}

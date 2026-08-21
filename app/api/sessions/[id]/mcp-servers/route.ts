import { getCredentialEncryptionSecret } from "@/db/index";
import {
  createSessionMcpServer,
  listSessionMcpServersForMember,
  McpServerConflictError,
  McpServerLimitError,
} from "@/db/mcp-servers";
import { SessionEndedError } from "@/db/sessions";
import { readJson } from "@/lib/floor-api";
import { parseMcpServerCreateInput } from "@/lib/mcp-config";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const servers = await listSessionMcpServersForMember((await params).id, user.id);
  if (!servers) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({ servers });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseMcpServerCreateInput(await readJson(request));
  if (!input) {
    return Response.json(
      { error: "An MCP server needs a lowercase slug name (\"openfloor\" is reserved), transport http or sse, an https URL, and optionally bounded headers." },
      { status: 400 },
    );
  }
  try {
    const servers = await createSessionMcpServer((await params).id, user.id, input, getCredentialEncryptionSecret());
    if (!servers) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({ servers }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionEndedError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof McpServerLimitError || error instanceof McpServerConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

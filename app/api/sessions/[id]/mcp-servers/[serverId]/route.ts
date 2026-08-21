import { getCredentialEncryptionSecret } from "@/db/index";
import { deleteSessionMcpServer, updateSessionMcpServer } from "@/db/mcp-servers";
import { SessionEndedError } from "@/db/sessions";
import { readJson } from "@/lib/floor-api";
import { parseMcpServerUpdateInput } from "@/lib/mcp-config";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const update = parseMcpServerUpdateInput(await readJson(request));
  if (!update) return Response.json({ error: "Provide at least one of transport, url, headers, or enabled" }, { status: 400 });
  const { id, serverId } = await params;
  try {
    const servers = await updateSessionMcpServer(id, user.id, serverId, update, getCredentialEncryptionSecret());
    if (!servers) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({ servers });
  } catch (error) {
    if (error instanceof SessionEndedError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id, serverId } = await params;
  try {
    const servers = await deleteSessionMcpServer(id, user.id, serverId);
    if (!servers) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({ servers });
  } catch (error) {
    if (error instanceof SessionEndedError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}

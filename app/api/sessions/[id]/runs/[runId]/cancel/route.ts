import { finishAgentRun, requestAgentRunCancellation } from "@/db/runs";
import { getFloorSnapshot } from "@/db/floor";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { env } from "cloudflare:workers";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, runId } = await params;
  const cancelled = await requestAgentRunCancellation(sessionId, runId, user.id);
  if (cancelled === null) return Response.json({ error: "Session not found" }, { status: 404 });
  if (!cancelled) return Response.json({ error: "This run can no longer be cancelled" }, { status: 409 });
  const bindings = env as unknown as { OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string; OPENFLOOR_TEST_AGENT_RUN_DATA?: string };
  if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true" && bindings.OPENFLOOR_TEST_AGENT_RUN_DATA) {
    await finishAgentRun(runId, "cancelled", "Agent run cancelled. No repository changes were published.");
  }
  const floor = await getFloorSnapshot(sessionId, user.id);
  if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
  await notifyFloorChanged(sessionId, floor.revision, ["queue", "runs", "review"]);
  return Response.json({ floor }, { status: 202 });
}

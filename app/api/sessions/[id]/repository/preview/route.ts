import { env } from "cloudflare:workers";
import { getFloorSnapshot } from "@/db/floor";
import {
  RepositoryPreviewCapacityError,
  RepositoryPreviewNotReadyError,
  failRepositoryPreview,
  getRepositoryPreviewRecord,
  reserveRepositoryPreview,
  stopRepositoryPreview,
} from "@/db/previews";
import { activeOwnerErrorResponse, quotaExhaustedErrorResponse } from "@/lib/floor-api";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

type WorkflowBinding = { create(options: { id: string; params: { previewId: string; generation: number } }): Promise<unknown> };

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const quotaError = await quotaExhaustedErrorResponse(sessionId);
  if (quotaError) return quotaError;
  const bindings = env as unknown as { REPOSITORY_PREVIEW?: WorkflowBinding; OPENFLOOR_PREVIEW_HOSTNAME?: string };
  if (!bindings.REPOSITORY_PREVIEW || !bindings.OPENFLOOR_PREVIEW_HOSTNAME) {
    return Response.json({ error: "Repository preview is not available" }, { status: 503 });
  }
  let reserved: Awaited<ReturnType<typeof reserveRepositoryPreview>> | null = null;
  try {
    const before = await getRepositoryPreviewRecord(sessionId);
    const preview = await reserveRepositoryPreview(sessionId, user.id);
    reserved = preview;
    await notifyFloorChanged(sessionId, (await getFloorSnapshot(sessionId, user.id))!.revision, ["preview"]);
    if (before?.workflowInstanceId !== preview.workflowInstanceId || before.status !== "provisioning") {
      await bindings.REPOSITORY_PREVIEW.create({
        id: preview.workflowInstanceId!,
        params: { previewId: preview.id, generation: preview.generation },
      });
    }
    return Response.json({ floor: await getFloorSnapshot(sessionId, user.id) }, { status: 202 });
  } catch (error) {
    if (error instanceof RepositoryPreviewCapacityError) return Response.json({ error: error.message }, { status: 503 });
    if (error instanceof RepositoryPreviewNotReadyError) {
      return Response.json({ error: error.message }, { status: error.message === "Session not found" ? 404 : 409 });
    }
    if (reserved) {
      const failed = await failRepositoryPreview(reserved.id, reserved.generation, "Repository preview could not be started");
      if (failed) await notifyFloorChanged(failed.sessionId, failed.revision, ["preview"]);
    }
    return Response.json({ error: "Repository preview could not be started" }, { status: 502 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const stopped = await stopRepositoryPreview(sessionId);
  if (stopped) {
    await notifyFloorChanged(sessionId, stopped.revision, ["preview"]);
    const namespace = (env as unknown as { SANDBOX?: DurableObjectNamespace<Sandbox> }).SANDBOX;
    if (namespace) await Promise.all(stopped.sandboxIds.map(async (sandboxId) => {
      try { await getSandbox(namespace, sandboxId, { enableDefaultSession: false, normalizeId: true }).destroy(); } catch { /* URL already revoked */ }
    }));
  }
  return Response.json({ floor: await getFloorSnapshot(sessionId, user.id) });
}

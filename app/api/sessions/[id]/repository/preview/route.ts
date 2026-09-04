import { env } from "cloudflare:workers";
import { getFloorSnapshot } from "@/db/floor";
import {
  RepositoryPreviewCapacityError,
  RepositoryPreviewNotReadyError,
  failRepositoryPreview,
  reserveRepositoryPreview,
  stopRepositoryPreview,
} from "@/db/previews";
import { activeOwnerErrorResponse, quotaExhaustedErrorResponse } from "@/lib/floor-api";
import { notifyFloorChanged } from "@/lib/presence-server";
import { destroyPreviewSandboxes, repositoryPreviewEnabled } from "@/lib/repository-preview-lifecycle";
import { isApiError, requireApiUser } from "@/lib/server-auth";

type WorkflowBinding = { create(options: { id: string; params: { previewId: string; generation: number } }): Promise<unknown> };

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const bindings = env as unknown as { REPOSITORY_PREVIEW_ENABLED?: string; REPOSITORY_PREVIEW?: WorkflowBinding; OPENFLOOR_PREVIEW_HOSTNAME?: string };
  if (!repositoryPreviewEnabled(bindings) || !bindings.REPOSITORY_PREVIEW || !bindings.OPENFLOOR_PREVIEW_HOSTNAME) {
    return Response.json({ error: "Repository preview is not available" }, { status: 404 });
  }
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const quotaError = await quotaExhaustedErrorResponse(sessionId);
  if (quotaError) return quotaError;
  let reserved: Awaited<ReturnType<typeof reserveRepositoryPreview>> | null = null;
  try {
    const preview = await reserveRepositoryPreview(sessionId, user.id);
    reserved = preview;
    await notifyFloorChanged(sessionId, (await getFloorSnapshot(sessionId, user.id))!.revision, ["preview"]);
    if (preview.reservationCreated) {
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
  const bindings = env as unknown as { REPOSITORY_PREVIEW_ENABLED?: string };
  if (!repositoryPreviewEnabled(bindings)) return Response.json({ error: "Repository preview is not available" }, { status: 404 });
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const stopped = await stopRepositoryPreview(sessionId);
  if (stopped) {
    await notifyFloorChanged(sessionId, stopped.revision, ["preview"]);
    await destroyPreviewSandboxes(stopped.sandboxIds);
  }
  return Response.json({ floor: await getFloorSnapshot(sessionId, user.id) });
}

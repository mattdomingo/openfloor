import { env } from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  failRepositoryPreview,
  finishSandboxCleanup,
  reserveAutomaticRepositoryPreview,
  retrySandboxCleanup,
  stopRepositoryPreview,
} from "@/db/previews";
import { getDb, type D1DatabaseLike } from "@/db";
import { notifyFloorChanged } from "./presence-server";

type PreviewWorkflowBinding = {
  create(options: { id: string; params: { previewId: string; generation: number } }): Promise<unknown>;
};

type PreviewBindings = {
  DB?: unknown;
  REPOSITORY_PREVIEW_ENABLED?: string;
  REPOSITORY_PREVIEW?: PreviewWorkflowBinding;
  SANDBOX?: DurableObjectNamespace<Sandbox>;
  OPENFLOOR_PREVIEW_HOSTNAME?: string;
};

export function repositoryPreviewEnabled(bindings: PreviewBindings): boolean {
  return bindings.REPOSITORY_PREVIEW_ENABLED === "true";
}

// Best-effort: integration/rollback remains authoritative if preview rebuild
// cannot launch. Existing active preview survives a failed replacement.
export async function refreshRepositoryPreview(
  sessionId: string,
  database: D1DatabaseLike = getDb(),
): Promise<void> {
  let preview: Awaited<ReturnType<typeof reserveAutomaticRepositoryPreview>> = null;
  try {
    const bindings = env as unknown as PreviewBindings;
    if (!repositoryPreviewEnabled(bindings) || !bindings.REPOSITORY_PREVIEW || !bindings.OPENFLOOR_PREVIEW_HOSTNAME) return;
    preview = await reserveAutomaticRepositoryPreview(sessionId, database);
    if (!preview?.workflowInstanceId) return;
    await bindings.REPOSITORY_PREVIEW.create({
      id: preview.workflowInstanceId,
      params: { previewId: preview.id, generation: preview.generation },
    });
    await notifyFloorChanged(sessionId, await currentRevision(sessionId, database), ["preview"]);
  } catch {
    try {
      if (!preview) return;
      const failed = await failRepositoryPreview(preview.id, preview.generation, "Automatic preview rebuild could not be started.", database);
      if (failed) await notifyFloorChanged(failed.sessionId, failed.revision, ["preview"]);
    } catch {
      // Preview refresh never changes authoritative integration/rollback.
    }
  }
}

export async function stopRepositoryPreviewRuntime(
  sessionId: string,
  database: D1DatabaseLike = getDb(),
): Promise<void> {
  const stopped = await stopRepositoryPreview(sessionId, database);
  if (!stopped) return;
  await notifyFloorChanged(sessionId, stopped.revision, ["preview"]);
  await destroyPreviewSandboxes(stopped.sandboxIds, database);
}

export async function destroyPreviewSandboxes(
  sandboxIds: string[],
  database: D1DatabaseLike = getDb(),
): Promise<void> {
  const bindings = env as unknown as PreviewBindings;
  if (!bindings.SANDBOX) return;
  await Promise.all(sandboxIds.map(async (sandboxId) => {
    try {
      await getSandbox(bindings.SANDBOX!, sandboxId, { enableDefaultSession: false, normalizeId: true }).destroy();
      await finishSandboxCleanup(sandboxId, database);
    } catch (error) {
      await retrySandboxCleanup(sandboxId, error instanceof Error ? error.message : "Sandbox destruction failed", database);
    }
  }));
}

async function currentRevision(sessionId: string, database: D1DatabaseLike): Promise<number> {
  const row = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(sessionId).first<{ revision: number }>();
  return Number(row?.revision ?? 0);
}

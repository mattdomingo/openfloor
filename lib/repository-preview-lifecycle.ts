import { env } from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  failRepositoryPreview,
  reserveAutomaticRepositoryPreview,
  stopRepositoryPreview,
} from "@/db/previews";
import { notifyFloorChanged } from "./presence-server";

type PreviewWorkflowBinding = {
  create(options: { id: string; params: { previewId: string; generation: number } }): Promise<unknown>;
};

type PreviewBindings = {
  REPOSITORY_PREVIEW?: PreviewWorkflowBinding;
  SANDBOX?: DurableObjectNamespace<Sandbox>;
  OPENFLOOR_PREVIEW_HOSTNAME?: string;
};

// Best-effort by design: repository integration/rollback remains authoritative
// even when preview capacity or Workflow launch is unavailable.
export async function refreshRepositoryPreview(sessionId: string): Promise<void> {
  let preview: Awaited<ReturnType<typeof reserveAutomaticRepositoryPreview>> = null;
  try {
    const bindings = env as unknown as PreviewBindings;
    if (!bindings.REPOSITORY_PREVIEW || !bindings.OPENFLOOR_PREVIEW_HOSTNAME) return;
    preview = await reserveAutomaticRepositoryPreview(sessionId);
    if (!preview?.workflowInstanceId) return;
    await bindings.REPOSITORY_PREVIEW.create({
      id: preview.workflowInstanceId,
      params: { previewId: preview.id, generation: preview.generation },
    });
    await notifyFloorChanged(sessionId, await currentRevision(sessionId), ["preview"]);
  } catch {
    // Preview refresh never changes authoritative integration/rollback outcome.
    try {
      if (!preview) return;
      const failed = await failRepositoryPreview(preview.id, preview.generation, "Automatic preview rebuild could not be started.");
      if (failed) await notifyFloorChanged(failed.sessionId, failed.revision, ["preview"]);
    } catch { /* refresh remains best-effort */ }
  }
}

export async function stopRepositoryPreviewRuntime(sessionId: string): Promise<void> {
  const stopped = await stopRepositoryPreview(sessionId);
  if (!stopped) return;
  await notifyFloorChanged(sessionId, stopped.revision, ["preview"]);
  const namespace = (env as unknown as PreviewBindings).SANDBOX;
  if (!namespace) return;
  await Promise.all(stopped.sandboxIds.map(async (sandboxId) => {
    try { await getSandbox(namespace, sandboxId, { enableDefaultSession: false, normalizeId: true }).destroy(); } catch { /* D1 lease is already revoked */ }
  }));
}

async function currentRevision(sessionId: string): Promise<number> {
  const { getDb } = await import("@/db");
  const row = await getDb().prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(sessionId).first<{ revision: number }>();
  return Number(row?.revision ?? 0);
}

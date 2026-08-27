import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1DatabaseLike } from "../db";
import {
  activateRepositoryPreview,
  failRepositoryPreview,
  getRepositoryPreviewExecutionContext,
} from "../db/previews";
import { notifyFloorChanged } from "../lib/presence-server";
import { signPreviewGatewayToken } from "../lib/runtime-token";

export interface PreviewWorkflowEnv {
  DB: D1DatabaseLike;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  RUNTIME_GATEWAY_SECRET: string;
  OPENFLOOR_RUNTIME_ORIGIN: string;
  OPENFLOOR_PREVIEW_HOSTNAME: string;
}

type Params = { previewId: string; generation: number };
const RELAY_PORT = 8080;

export class RepositoryPreviewWorkflow extends WorkflowEntrypoint<PreviewWorkflowEnv, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<{ status: string }> {
    const { previewId, generation } = event.payload;
    const context = await step.do("load preview lease", async () => {
      const value = await getRepositoryPreviewExecutionContext(previewId, generation, this.env.DB);
      if (!value) throw new Error("Repository preview lease is stale");
      return value;
    });
    const sandbox = getSandbox(this.env.SANDBOX, context.sandboxId, {
      keepAlive: true,
      enableDefaultSession: false,
      normalizeId: true,
      labels: { sessionId: context.sessionId, previewId, generation: String(generation) },
    });
    try {
      await step.do("fetch exact candidate source", {
        retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes",
      }, async () => {
        const token = await signPreviewGatewayToken({
          previewId,
          generation,
          sessionId: context.sessionId,
          repositoryId: context.repositoryId,
          candidateSha: context.candidateSha,
          operation: "source",
        }, this.env.RUNTIME_GATEWAY_SECRET);
        const result = await sandbox.exec(
          'mkdir -p /workspace/repository && curl --fail --silent --show-error --location --max-filesize 104857600 -H "Authorization: Bearer $OPENFLOOR_GATEWAY_TOKEN" "$OPENFLOOR_SOURCE_URL" | tar -xz --strip-components=1 -C /workspace/repository && chown -R openfloor-agent:openfloor-agent /workspace',
          {
            timeout: 4 * 60 * 1_000,
            env: {
              OPENFLOOR_GATEWAY_TOKEN: token,
              OPENFLOOR_SOURCE_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/preview/source`,
            },
          },
        );
        if (!result.success) throw new Error(`Candidate source checkout failed with exit code ${result.exitCode}`);
      });

      const detected = await step.do("detect and install root JavaScript app", { timeout: "15 minutes" }, async () => {
        const result = await sandbox.exec(
          "runuser -u openfloor-agent -- node /opt/openfloor/repository-preview.mjs --install /workspace/repository /workspace/preview-config.json",
          { timeout: 14 * 60 * 1_000 },
        );
        if (!result.success) throw new Error(lastUsefulLine(result.stderr) || "Preview dependency installation failed.");
        const configResult = await sandbox.exec("cat /workspace/preview-config.json", { timeout: 10_000 });
        if (!configResult.success) throw new Error("Preview detection result could not be read.");
        const parsed = JSON.parse(configResult.stdout) as { packageManager?: unknown; script?: unknown };
        if (!isPackageManager(parsed.packageManager) || (parsed.script !== "dev" && parsed.script !== "start")) {
          throw new Error("Preview detection returned an unsupported runtime.");
        }
        return { packageManager: parsed.packageManager, script: parsed.script as "dev" | "start" };
      });

      await step.do("start network-isolated app", { timeout: "2 minutes" }, async () => {
        await sandbox.startProcess(
          `runuser -u openfloor-agent -- bwrap --die-with-parent --unshare-net --ro-bind / / --bind /workspace /workspace --proc /proc --dev /dev --chdir /workspace/repository /usr/bin/node /opt/openfloor/preview-runtime.mjs ${detected.packageManager} ${detected.script}`,
          { processId: "preview-app", autoCleanup: false },
        );
        const ready = await sandbox.exec(
          "for i in $(seq 1 180); do test -S /workspace/preview.sock && exit 0; sleep 0.5; done; exit 1",
          { timeout: 95_000 },
        );
        if (!ready.success) throw new Error("Preview app did not expose one HTTP listener.");
        await sandbox.startProcess(
          `socat TCP-LISTEN:${RELAY_PORT},fork,reuseaddr UNIX-CONNECT:/workspace/preview.sock`,
          { processId: "preview-relay", autoCleanup: false },
        );
      });

      const exposed = await step.do("expose preview relay", async () => {
        return sandbox.exposePort(RELAY_PORT, {
          hostname: this.env.OPENFLOOR_PREVIEW_HOSTNAME,
          name: "openfloor-review-preview",
        });
      });
      const url = new URL(exposed.url);
      const activated = await step.do("activate preview generation", async () => activateRepositoryPreview(
        previewId,
        generation,
        { url: exposed.url, host: url.host.toLowerCase(), packageManager: detected.packageManager, script: detected.script },
        this.env.DB,
      ));
      if (!activated) {
        await sandbox.destroy();
        return { status: "stale" };
      }
      await notifyFloorChanged(activated.sessionId, activated.revision, ["preview"]);
      if (activated.oldSandboxId && activated.oldSandboxId !== context.sandboxId) {
        try {
          await getSandbox(this.env.SANDBOX, activated.oldSandboxId, {
            enableDefaultSession: false,
            normalizeId: true,
          }).destroy();
        } catch {
          // Old host is already revoked in D1; Sandbox retention is fallback cleanup.
        }
      }
      return { status: "ready" };
    } catch (error) {
      try { await sandbox.destroy(); } catch { /* stale generation remains unreachable */ }
      const failed = await failRepositoryPreview(
        previewId,
        generation,
        error instanceof Error ? error.message : "Repository preview failed.",
        this.env.DB,
      );
      if (failed) await notifyFloorChanged(failed.sessionId, failed.revision, ["preview"]);
      return { status: failed ? "failed" : "stale" };
    }
  }
}

function isPackageManager(value: unknown): value is "npm" | "pnpm" | "yarn" | "bun" {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

function lastUsefulLine(value: string): string {
  return value.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 1_000) ?? "";
}

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1DatabaseLike } from "../db";
import {
  activateRepositoryPreview,
  enqueueSandboxCleanup,
  failRepositoryPreview,
  finishSandboxCleanup,
  getRepositoryPreviewExecutionContext,
  retrySandboxCleanup,
} from "../db/previews";
import { buildGeminiSrtSettings } from "../lib/gemini-settings";
import { notifyFloorChanged } from "../lib/presence-server";
import { isPreviewHostname } from "../lib/preview-proxy";
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
const SRT_SETTINGS = "/tmp/openfloor/workspace-srt-settings.json";
const PREVIEW_SOCKET = "/workspace/preview-relay/preview.sock";

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
          "rm -rf /workspace/repository /workspace/preview-relay /tmp/openfloor && mkdir -p /workspace/repository /workspace/preview-relay /tmp/openfloor/workspace-home && "
          + "curl --fail --silent --show-error --location --max-filesize 104857600 -H \"Authorization: Bearer $OPENFLOOR_GATEWAY_TOKEN\" \"$OPENFLOOR_SOURCE_URL\" "
          + "| tar -xz --strip-components=1 -C /workspace/repository && chown -R openfloor-workspace:openfloor-shared /workspace /tmp/openfloor/workspace-home && chmod 0700 /tmp/openfloor/workspace-home",
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
        await writeLockedSrtSettings(sandbox, buildGeminiSrtSettings({
          gatewayHost: new URL(this.env.OPENFLOOR_RUNTIME_ORIGIN).host,
          workspace: "/workspace/repository",
          allowedDomains: ["registry.npmjs.org"],
        }));
        const result = await sandbox.exec(
          "/opt/openfloor/openfloor-workspace-exec node /opt/openfloor/repository-preview.mjs --install /workspace/repository /tmp/openfloor/preview-config.json",
          { timeout: 14 * 60 * 1_000 },
        );
        if (!result.success) throw new Error(lastUsefulLine(result.stderr) || "Preview dependency installation failed.");
        const configResult = await sandbox.exec("cat /tmp/openfloor/preview-config.json", { timeout: 10_000 });
        if (!configResult.success) throw new Error("Preview detection result could not be read.");
        const parsed = JSON.parse(configResult.stdout) as { packageManager?: unknown; script?: unknown };
        if (!isPackageManager(parsed.packageManager) || (parsed.script !== "dev" && parsed.script !== "start")) {
          throw new Error("Preview detection returned an unsupported runtime.");
        }
        return { packageManager: parsed.packageManager, script: parsed.script as "dev" | "start" };
      });

      await step.do("start network-isolated app", { timeout: "2 minutes" }, async () => {
        await writeLockedSrtSettings(sandbox, buildGeminiSrtSettings({
          gatewayHost: new URL(this.env.OPENFLOOR_RUNTIME_ORIGIN).host,
          workspace: "/workspace/repository",
          allowAllUnixSockets: true,
          bwrapPath: "/opt/openfloor/openfloor-preview-bwrap",
          additionalWritePaths: ["/workspace/preview-relay"],
        }));
        await sandbox.startProcess(
          `/opt/openfloor/openfloor-preview-exec ${detected.packageManager} ${detected.script}`,
          { processId: "preview-app", autoCleanup: false },
        );
        const socket = await sandbox.exec(
          `for i in $(seq 1 180); do test -S ${PREVIEW_SOCKET} && exit 0; sleep 0.5; done; exit 1`,
          { timeout: 95_000 },
        );
        if (!socket.success) throw new Error("Preview relay socket was not created.");
        const locked = await sandbox.exec(
          `chown root:root /workspace/preview-relay && chmod 0555 /workspace/preview-relay && chown root:openfloor-shared ${PREVIEW_SOCKET} && chmod 0660 ${PREVIEW_SOCKET}`,
          { timeout: 30_000 },
        );
        if (!locked.success) throw new Error("Preview relay socket could not be locked.");
        const ready = await sandbox.exec(
          `for i in $(seq 1 180); do curl --silent --output /dev/null --max-time 1 --unix-socket ${PREVIEW_SOCKET} http://localhost/ && exit 0; sleep 0.5; done; exit 1`,
          { timeout: 95_000 },
        );
        if (!ready.success) throw new Error("Preview app did not expose one HTTP listener.");
        await sandbox.startProcess(
          `socat TCP-LISTEN:${RELAY_PORT},fork,reuseaddr UNIX-CONNECT:${PREVIEW_SOCKET}`,
          { processId: "preview-relay", autoCleanup: false },
        );
      });

      const exposed = await step.do("expose preview relay", async () => sandbox.exposePort(RELAY_PORT, {
        hostname: this.env.OPENFLOOR_PREVIEW_HOSTNAME,
        name: "openfloor-review-preview",
      }));
      const url = new URL(exposed.url);
      if (url.protocol !== "https:" || !isPreviewHostname(url.hostname, this.env.OPENFLOOR_PREVIEW_HOSTNAME)) {
        throw new Error("Sandbox returned an invalid preview hostname.");
      }
      const activated = await step.do("activate preview generation", async () => activateRepositoryPreview(
        previewId,
        generation,
        { url: exposed.url, host: url.host.toLowerCase(), packageManager: detected.packageManager, script: detected.script },
        this.env.DB,
      ));
      if (!activated) {
        await cleanupSandbox(sandbox, context.sandboxId, this.env.DB);
        return { status: "stale" };
      }
      await notifyFloorChanged(activated.sessionId, activated.revision, ["preview"]);
      if (activated.oldSandboxId && activated.oldSandboxId !== context.sandboxId) {
        await cleanupSandbox(
          getSandbox(this.env.SANDBOX, activated.oldSandboxId, { enableDefaultSession: false, normalizeId: true }),
          activated.oldSandboxId,
          this.env.DB,
        );
      }
      return { status: "ready" };
    } catch (error) {
      const failed = await failRepositoryPreview(
        previewId,
        generation,
        error instanceof Error ? error.message : "Repository preview failed.",
        this.env.DB,
      );
      await cleanupSandbox(sandbox, context.sandboxId, this.env.DB);
      if (failed) await notifyFloorChanged(failed.sessionId, failed.revision, ["preview"]);
      return { status: failed ? "failed" : "stale" };
    }
  }
}

async function writeLockedSrtSettings(sandbox: ReturnType<typeof getSandbox>, contents: string): Promise<void> {
  await sandbox.writeFile(SRT_SETTINGS, contents);
  const locked = await sandbox.exec(`chown root:root ${SRT_SETTINGS} && chmod 0444 ${SRT_SETTINGS}`, { timeout: 30_000 });
  if (!locked.success) throw new Error("Preview sandbox settings could not be locked.");
}

async function cleanupSandbox(
  sandbox: ReturnType<typeof getSandbox>,
  sandboxId: string,
  database: D1DatabaseLike,
): Promise<void> {
  await enqueueSandboxCleanup([sandboxId], database);
  try {
    await sandbox.destroy();
    await finishSandboxCleanup(sandboxId, database);
  } catch (error) {
    await retrySandboxCleanup(sandboxId, error instanceof Error ? error.message : "Sandbox destruction failed", database);
  }
}

function isPackageManager(value: unknown): value is "npm" | "pnpm" | "yarn" | "bun" {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

function lastUsefulLine(value: string): string {
  return value.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 1_000) ?? "";
}

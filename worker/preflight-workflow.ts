import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  finishPreflightCheck,
  finishRepositoryPreflight,
  getPreflightExecutionContext,
  markPreflightCheckRunning,
  markPreflightRunning,
} from "../db/preflights";
import type { D1DatabaseLike } from "../db";
import { notifyFloorChanged } from "../lib/presence-server";
import { signPreflightGatewayToken } from "../lib/runtime-token";

type R2BucketLike = { put(key: string, value: string, options?: unknown): Promise<unknown> };

export interface PreflightWorkflowEnv {
  DB: D1DatabaseLike;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  PREFLIGHT_LOGS: R2BucketLike;
  RUNTIME_GATEWAY_SECRET: string;
  OPENFLOOR_RUNTIME_ORIGIN: string;
}

type Params = { preflightId: string };
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_BYTES = 200_000;
const MAX_EXCERPT_CHARS = 2_000;

export class RepositoryPreflightWorkflow extends WorkflowEntrypoint<PreflightWorkflowEnv, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<{ status: string }> {
    const preflightId = event.payload.preflightId;
    const context = await step.do("load preflight", async () => {
      const value = await getPreflightExecutionContext(preflightId, this.env.DB);
      if (!value) throw new Error("Repository preflight no longer exists");
      await markPreflightRunning(preflightId, this.env.DB);
      return value;
    });
    const sandbox = getSandbox(this.env.SANDBOX, `preflight-${preflightId}`, {
      keepAlive: true,
      enableDefaultSession: false,
      normalizeId: true,
      labels: { sessionId: context.sessionId, preflightId },
    });
    let finalStatus: "passed" | "failed" | "timed_out" = "failed";
    let summary = "Repository preflight failed before checks completed.";
    try {
      await step.do("fetch exact candidate source", { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
        const gatewayToken = await signPreflightGatewayToken({
          preflightId,
          sessionId: context.sessionId,
          repositoryId: context.repositoryId,
          candidateSha: context.candidateSha,
          operation: "source",
        }, this.env.RUNTIME_GATEWAY_SECRET);
        const sourceUrl = `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/preflight/source`;
        const result = await sandbox.exec(
          'mkdir -p /workspace/repository && curl --fail --silent --show-error --location --max-filesize 104857600 -H "Authorization: Bearer $OPENFLOOR_GATEWAY_TOKEN" "$OPENFLOOR_SOURCE_URL" | tar -xz --strip-components=1 -C /workspace/repository',
          { timeout: 4 * 60 * 1000, env: { OPENFLOOR_GATEWAY_TOKEN: gatewayToken, OPENFLOOR_SOURCE_URL: sourceUrl } },
        );
        if (!result.success) throw new Error(`Candidate source checkout failed with exit code ${result.exitCode}`);
      });

      finalStatus = "passed";
      summary = `All ${context.checks.length} required checks passed.`;
      for (const check of context.checks) {
        const result = await step.do(`required check ${check.position + 1}`, { retries: { limit: 0, delay: "1 second" }, timeout: "11 minutes" }, async () => {
          await markPreflightCheckRunning(preflightId, check.id, this.env.DB);
          const startedAt = Date.now();
          try {
            const execution = await sandbox.exec(check.command, { cwd: "/workspace/repository", timeout: COMMAND_TIMEOUT_MS });
            const log = boundedLog(execution.stdout, execution.stderr);
            const logKey = `preflights/${preflightId}/checks/${check.position}.log`;
            await this.env.PREFLIGHT_LOGS.put(logKey, log, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
            const status = execution.success ? "passed" : "failed";
            await finishPreflightCheck(preflightId, check.id, {
              status,
              exitCode: execution.exitCode,
              durationMs: Date.now() - startedAt,
              outputExcerpt: log.slice(-MAX_EXCERPT_CHARS),
              logKey,
            }, this.env.DB);
            return { status, exitCode: execution.exitCode } as const;
          } catch (error) {
            const timedOut = String(error).toLowerCase().includes("timeout");
            const message = boundedLog("", error instanceof Error ? error.message : "Sandbox command failed");
            const logKey = `preflights/${preflightId}/checks/${check.position}.log`;
            await this.env.PREFLIGHT_LOGS.put(logKey, message, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
            await finishPreflightCheck(preflightId, check.id, {
              status: timedOut ? "timed_out" : "failed",
              exitCode: null,
              durationMs: Date.now() - startedAt,
              outputExcerpt: message.slice(-MAX_EXCERPT_CHARS),
              logKey,
            }, this.env.DB);
            return { status: timedOut ? "timed_out" : "failed", exitCode: null } as const;
          }
        });
        if (result.status !== "passed") {
          finalStatus = result.status;
          summary = result.status === "timed_out"
            ? `Required check ${check.position + 1} timed out.`
            : `Required check ${check.position + 1} failed${result.exitCode == null ? "." : ` with exit code ${result.exitCode}.`}`;
          break;
        }
      }
    } catch (error) {
      finalStatus = String(error).toLowerCase().includes("timeout") ? "timed_out" : "failed";
      summary = error instanceof Error ? error.message : "Repository preflight failed.";
    } finally {
      try {
        await step.do("destroy sandbox", { retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" }, async () => sandbox.destroy());
      } catch {
        finalStatus = "failed";
        summary = `${summary} Sandbox cleanup did not complete.`;
      }
    }
    const completion = await step.do("record completion", async () => finishRepositoryPreflight(preflightId, finalStatus, summary, this.env.DB));
    if (completion) await notifyFloorChanged(completion.sessionId, completion.revision, ["repository", "review"]);
    return { status: finalStatus };
  }
}

function boundedLog(stdout: string, stderr: string): string {
  const combined = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`;
  if (combined.length <= MAX_LOG_BYTES) return combined;
  const half = Math.floor((MAX_LOG_BYTES - 80) / 2);
  return `${combined.slice(0, half)}\n\n[openfloor truncated ${combined.length - half * 2} characters]\n\n${combined.slice(-half)}`;
}

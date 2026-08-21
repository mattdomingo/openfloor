import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1DatabaseLike } from "../db";
import {
  bumpAgentRunRevision,
  beginRunIntegration,
  cancelRunIntegration,
  finishAgentRun,
  finishRunCheck,
  finishRunPublished,
  finishRunIntegrated,
  getRunExecutionContext,
  isRunCancellationRequested,
  markRunChecking,
  markRunCheckRunning,
  markRunRunning,
  markRunPublishing,
  markRunIntegrationConflicted,
  releaseRunIntegration,
  recordRunPublicationFailure,
  recordRunArtifact,
  replaceRunFiles,
  setRunProcessId,
  setRunSandboxId,
} from "../db/runs";
import { claimPoolSandbox, releasePoolSandbox, retirePoolSandbox } from "../db/sandbox-pool";
import { getSessionContext, viewerFromRunContext } from "../db/session-context";
import { getGitHubAppConfig } from "../db";
import { createDraftPullRequest, createInstallationToken, getRepositoryRefSha, GitHubApiError, mergeRepositoryBranch } from "../lib/github";
import type { AgentRunFile } from "../lib/floor-types";
import type { GitHubRepositoryOption } from "../lib/session-types";
import { renderSessionContext } from "../lib/session-context";
import { getSessionSkillsForRun } from "../db/skills";
import { buildClaudeSandboxSettings } from "../lib/claude-sandbox-settings";
import { notifyFloorChanged } from "../lib/presence-server";
import { pokeSessionRouter } from "../lib/router-server";
import { signRunGatewayToken } from "../lib/runtime-token";

type R2BucketLike = { put(key: string, value: string, options?: unknown): Promise<unknown> };

export interface AgentRunWorkflowEnv {
  DB: D1DatabaseLike;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  PREFLIGHT_LOGS: R2BucketLike;
  RUNTIME_GATEWAY_SECRET: string;
  OPENFLOOR_RUNTIME_ORIGIN: string;
}

type Params = { runId: string };
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_BYTES = 500_000;
const MAX_DIFF_BYTES = 2_000_000;
const MAX_FILES = 100;
const PUBLISHER_SANDBOX_IMAGE_VERSION = "v2";
// Pooled run sandboxes are keyed only by repository (see db/sandbox-pool.ts),
// so a container built from a stale image would otherwise stay claimable for
// up to POOL_IDLE_TTL_MS after a deploy that changed Dockerfile.sandbox.
// Namespacing the pool key by image version makes old-image entries
// unreachable immediately; the existing idle sweep reclaims them.
// Bump this whenever Dockerfile.sandbox's run-sandbox contents change.
const RUN_SANDBOX_IMAGE_VERSION = "v2";

export class AgentRunWorkflow extends WorkflowEntrypoint<AgentRunWorkflowEnv, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<{ status: string }> {
    const runId = event.payload.runId;
    const context = await step.do("load run", async () => {
      const value = await getRunExecutionContext(runId, this.env.DB);
      if (!value) throw new Error("Agent run no longer exists");
      return value;
    });
    // The run sandbox comes from the warm pool and is claimed only on the
    // fresh-run path (resume paths never touch it); see the claim step below.
    let pooled: { id: string; sandbox: ReturnType<typeof getSandbox<Sandbox>> } | null = null;
    const publisher = getSandbox(this.env.SANDBOX, `publisher-${PUBLISHER_SANDBOX_IMAGE_VERSION}-${event.instanceId}`, {
      keepAlive: true,
      enableDefaultSession: false,
      normalizeId: true,
      labels: { sessionId: context.sessionId, runId, purpose: "trusted-publisher" },
    });
    let finalStatus: "ready" | "failed" | "cancelled" = "failed";
    let summary = "Agent run failed before the agent completed.";
    try {
      if (context.status === "published") return await this.integrate(runId, step);
      if (["integrated", "conflicted"].includes(context.status)) return { status: context.status };
      if (context.status === "publishing") {
        if (!context.bundleKey || !context.localCommitSha || context.files.length === 0) {
          throw new Error("Stored publication metadata is incomplete");
        }
        const published = await this.publishBundle(runId, context, context.files, { localCommitSha: context.localCommitSha }, publisher, step);
        const completion = await finishRunPublished(runId, published.commitSha, published.remoteSha, this.env.DB);
        if (completion) await notifyFloorChanged(completion.sessionId, completion.revision, ["queue", "runs", "review"]);
        return await this.integrate(runId, step);
      }
      if (await isRunCancellationRequested(runId, this.env.DB)) {
        finalStatus = "cancelled";
        summary = "Agent run cancelled before provisioning completed.";
        return await this.complete(runId, finalStatus, summary);
      }
      // Claim a warm same-repository sandbox (or create a fresh pool entry) so
      // repeat runs skip the container cold start and reuse the npm cache. The
      // id is recorded on the run before any provisioning work.
      const sandboxId = await step.do("claim warm sandbox", async () => {
        const id = await claimPoolSandbox(`${RUN_SANDBOX_IMAGE_VERSION}:${context.repositoryId}`, runId, this.env.DB);
        await setRunSandboxId(runId, id, this.env.DB);
        return id;
      });
      const sandbox = getSandbox(this.env.SANDBOX, sandboxId, {
        keepAlive: true,
        enableDefaultSession: false,
        normalizeId: true,
        labels: { sessionId: context.sessionId, runId },
      });
      pooled = { id: sandboxId, sandbox };
      await step.do("prepare exact workspace", { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
        const sourceToken = await signRunGatewayToken({
          runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
          candidateSha: context.candidateSha, operation: "source",
        }, this.env.RUNTIME_GATEWAY_SECRET);
        const result = await sandbox.exec(
          `mkdir -p /workspace/repository /tmp/openfloor && find /workspace/repository -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + &&
           curl --fail --silent --show-error --location --max-filesize 104857600 -H "Authorization: Bearer $OPENFLOOR_SOURCE_TOKEN" "$OPENFLOOR_SOURCE_URL" |
             tar -xz --strip-components=1 -C /workspace/repository &&
           git -C /workspace/repository init -q && git -C /workspace/repository config user.name openfloor &&
           git -C /workspace/repository config user.email runtime@opnflr.com && git -C /workspace/repository add -A &&
           OPENFLOOR_TREE=$(git -C /workspace/repository write-tree) &&
           OPENFLOOR_BASE=$(printf 'openfloor candidate baseline\n' | env GIT_AUTHOR_NAME=openfloor GIT_AUTHOR_EMAIL=runtime@opnflr.com GIT_COMMITTER_NAME=openfloor GIT_COMMITTER_EMAIL=runtime@opnflr.com GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git -C /workspace/repository commit-tree "$OPENFLOOR_TREE") &&
           git -C /workspace/repository update-ref refs/heads/openfloor-base "$OPENFLOOR_BASE" &&
           git -C /workspace/repository reset -q --hard "$OPENFLOOR_BASE"`,
          { timeout: 4 * 60 * 1000, env: {
            OPENFLOOR_SOURCE_TOKEN: sourceToken,
            OPENFLOOR_SOURCE_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/run/source`,
          } },
        );
        if (!result.success) throw new Error(`Candidate workspace preparation failed with exit code ${result.exitCode}`);
        let prompt = await buildRunPrompt(context, this.env.DB);
        if (context.provider === "anthropic") {
          // The target repository's CLAUDE.md is useful context, but it is
          // deliberately NOT loaded as a settings source — user-scope keeps
          // the repo's .claude/ out of the session — so read it as text into
          // the prompt, bounded like every other brief section.
          const claudeMd = await sandbox.exec(
            "head -c 8000 /workspace/repository/CLAUDE.md 2>/dev/null || true",
            { timeout: 30_000 },
          );
          if (claudeMd.success && claudeMd.stdout.trim()) {
            prompt += `\n\n## Repository CLAUDE.md (first 8,000 characters)\n\n${claudeMd.stdout}`;
          }
        }
        await sandbox.writeFile("/tmp/openfloor/prompt.txt", prompt);
        // Persisted so members can see exactly what a run was told — the
        // honest counterpart to injecting context they can't otherwise see.
        const promptKey = `runs/${runId}/prompt.txt`;
        await this.env.PREFLIGHT_LOGS.put(promptKey, prompt, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
        await recordRunArtifact(runId, "prompt", promptKey, "text/plain; charset=utf-8", prompt.length, this.env.DB);
        if (context.provider === "anthropic") {
          // Claude runs execute as a dedicated non-root user: the SDK's
          // kernel sandbox (bubblewrap via sandbox-runtime) cannot initialize
          // as root, and it is what keeps the two-layer isolation posture
          // real. Root keeps the pipeline (git reads, bundle export); the
          // workspace and result paths become agent-owned, and root's git
          // needs safe.directory once ownership differs.
          await sandbox.exec(
            "id -u openfloor-agent >/dev/null 2>&1 || useradd -m openfloor-agent; mkdir -p /home/openfloor-agent/.claude",
            { timeout: 30_000 },
          );
          await sandbox.writeFile(
            "/home/openfloor-agent/.claude/settings.json",
            buildClaudeSandboxSettings({ gatewayHost: new URL(this.env.OPENFLOOR_RUNTIME_ORIGIN).host }),
          );
          // Imported session skills materialize into the agent user's home
          // (user scope — never the git worktree, which would make them
          // changed paths the publisher then rejects). Names are validated
          // slugs at the write path; the re-check here keeps the exec safe
          // even against a hand-edited row.
          for (const skill of await getSessionSkillsForRun(context.sessionId, this.env.DB)) {
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name)) continue;
            await sandbox.exec(`mkdir -p /home/openfloor-agent/.claude/skills/${skill.name}`, { timeout: 30_000 });
            await sandbox.writeFile(`/home/openfloor-agent/.claude/skills/${skill.name}/SKILL.md`, skill.content);
          }
          const prepared = await sandbox.exec(
            "chown -R openfloor-agent:openfloor-agent /home/openfloor-agent /workspace/repository /tmp/openfloor && git config --global --add safe.directory /workspace/repository",
            { timeout: 60_000 },
          );
          if (!prepared.success) throw new Error(`Claude runtime preparation failed with exit code ${prepared.exitCode}`);
        }
      });

      const processId = `codex-${runId}`;
      await step.do("start Codex", { retries: { limit: 1, delay: "5 seconds" }, timeout: "2 minutes" }, async () => {
        const existing = await sandbox.getProcess(processId);
        if (!existing) {
          const providerToken = await signRunGatewayToken({
            runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
            candidateSha: context.candidateSha, operation: context.provider === "anthropic" ? "anthropic" : "openai",
          }, this.env.RUNTIME_GATEWAY_SECRET);
          const eventsToken = await signRunGatewayToken({
            runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
            candidateSha: context.candidateSha, operation: "events",
          }, this.env.RUNTIME_GATEWAY_SECRET);
          const contextToken = await signRunGatewayToken({
            runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
            candidateSha: context.candidateSha, operation: "context",
          }, this.env.RUNTIME_GATEWAY_SECRET);
          // runuser -p preserves the startProcess env (including the HOME set
          // below, which is where the pinned sandbox settings live) while
          // dropping to the non-root user the Claude sandbox requires.
          const command = context.provider === "anthropic"
            ? "runuser -p -u openfloor-agent -- node /opt/openfloor/claude-runner.mjs"
            : "node /opt/openfloor/codex-runner.mjs";
          const providerEnv = context.provider === "anthropic"
            ? {
                OPENFLOOR_ANTHROPIC_BASE_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/anthropic`,
                OPENFLOOR_ANTHROPIC_TOKEN: providerToken,
                HOME: "/home/openfloor-agent",
                // Names of the materialized skills; the runner passes them as
                // the SDK's explicit `skills` list ([] disables CLI skill
                // defaults — omitted is NOT off). A skill added between the
                // prepare and start steps is simply absent from this run.
                OPENFLOOR_SKILLS: JSON.stringify(
                  (await getSessionSkillsForRun(context.sessionId, this.env.DB)).map((skill) => skill.name),
                ),
              }
            : {
                OPENFLOOR_OPENAI_BASE_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/openai/v1`,
                OPENFLOOR_OPENAI_TOKEN: providerToken,
              };
          await sandbox.startProcess(command, {
            processId,
            autoCleanup: false,
            cwd: "/workspace/repository",
            env: {
              OPENFLOOR_PROMPT_PATH: "/tmp/openfloor/prompt.txt",
              OPENFLOOR_RESULT_PATH: "/tmp/openfloor/result.json",
              OPENFLOOR_WORKSPACE: "/workspace/repository",
              OPENFLOOR_MODEL: context.model,
              OPENFLOOR_EVENTS_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/run/events`,
              OPENFLOOR_EVENTS_TOKEN: eventsToken,
              OPENFLOOR_CONTEXT_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/run/context`,
              OPENFLOOR_CONTEXT_TOKEN: contextToken,
              OPENFLOOR_MCP_SERVER_PATH: "/opt/openfloor/openfloor-mcp.mjs",
              ...providerEnv,
            },
          });
        }
        await setRunProcessId(runId, processId, this.env.DB);
        await markRunRunning(runId, processId, this.env.DB);
        await this.notify(runId);
      });

      const processResult = await step.do("wait for Codex", { retries: { limit: 1, delay: "10 seconds" }, timeout: "60 minutes" }, async () => {
        const process = await sandbox.getProcess(processId);
        if (!process) throw new Error("The agent process could not be recovered");
        for (;;) {
          if (await isRunCancellationRequested(runId, this.env.DB)) {
            await process.kill("SIGTERM");
            return { cancelled: true, exitCode: 130, stdout: "", stderr: "Agent run cancelled." };
          }
          // Hold an exit-event stream instead of polling: one request per 15s
          // window and no completion lag, versus a status round trip every 2s.
          // The timeout bounds how long a cancellation request can go unnoticed.
          let exitCode: number;
          try {
            ({ exitCode } = await process.waitForExit(15_000));
          } catch {
            // Timed out (loop to re-check cancellation), or the log stream ended
            // without an exit event because the process was already gone — in
            // that case fall back to a status probe for the real outcome.
            const status = await process.getStatus();
            if (!["completed", "failed", "killed", "error"].includes(status)) continue;
            const finished = await sandbox.getProcess(processId);
            exitCode = finished?.exitCode ?? (status === "completed" ? 0 : 1);
          }
          const [status, logs] = await Promise.all([process.getStatus(), process.getLogs()]);
          return { cancelled: status === "killed", exitCode, ...logs };
        }
      });
      const codexLog = bounded(processResult.stdout, processResult.stderr, MAX_LOG_BYTES);
      const codexLogKey = `runs/${runId}/codex.log`;
      await this.env.PREFLIGHT_LOGS.put(codexLogKey, codexLog, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      await recordRunArtifact(runId, "codex_log", codexLogKey, "text/plain; charset=utf-8", codexLog.length, this.env.DB);
      if (processResult.cancelled || await isRunCancellationRequested(runId, this.env.DB)) {
        finalStatus = "cancelled";
        summary = "Agent run cancelled. No repository changes were published.";
        return await this.complete(runId, finalStatus, summary);
      }
      const resultFile = await sandbox.exec("cat /tmp/openfloor/result.json", { timeout: 10_000 });
      const codexResult = parseCodexResult(resultFile.stdout);
      if (processResult.exitCode !== 0 || !codexResult.ok) throw new Error(codexResult.error || `The agent process exited with code ${processResult.exitCode}`);
      await markRunChecking(runId, codexResult.threadId, codexResult.finalResponse, this.env.DB);
      await this.notify(runId);

      const files = await step.do("collect changed files", { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" }, async () => {
        await sandbox.exec("git add -N .", { cwd: "/workspace/repository", timeout: 30_000 });
        // Three repo-wide commands instead of three execs per file: each exec is
        // a Worker→DO→container round trip, so per-file fan-out cost O(N) waves.
        // --no-renames keeps numstat, status, and the diff on one entry per path.
        const [stats, statusResult, diff] = await Promise.all([
          sandbox.exec("git diff --numstat --no-renames -z HEAD", { cwd: "/workspace/repository", timeout: 60_000 }),
          sandbox.exec("git status --porcelain --no-renames -z", { cwd: "/workspace/repository", timeout: 60_000 }),
          sandbox.exec("git diff --no-color --no-renames --unified=3 HEAD", { cwd: "/workspace/repository", timeout: 60_000 }),
        ]);
        if (!stats.success || !statusResult.success) throw new Error("Unable to enumerate the agent's changes");
        // numstat -z entries: "additions\tdeletions\tpath\0" ("-" for binary counts).
        const numstats = stats.stdout.split("\0").filter(Boolean).map((entry) => {
          const [additions, deletions, path] = entry.split("\t");
          return { path, additions: Number(additions) || 0, deletions: Number(deletions) || 0 };
        });
        const paths = numstats.map((entry) => entry.path);
        if (paths.length === 0) throw new Error("The agent completed without changing any files");
        if (paths.length > MAX_FILES) throw new Error(`The agent changed more than ${MAX_FILES} files`);
        if (paths.some((path) => path === ".github/workflows" || path.startsWith(".github/workflows/"))) {
          throw new Error("Workflow-file changes are not allowed in this release");
        }
        // porcelain -z entries: "XY path\0"; rename/copy entries carry a second
        // NUL-terminated original path (defensive — --no-renames avoids them).
        const statusByPath = new Map<string, string>();
        const statusEntries = statusResult.stdout.split("\0").filter(Boolean);
        for (let index = 0; index < statusEntries.length; index += 1) {
          const entry = statusEntries[index];
          const code = entry.slice(0, 2);
          statusByPath.set(entry.slice(3), code);
          if (code.includes("R") || code.includes("C")) index += 1;
        }
        // The unified diff lists files in the same order as numstat; split it on
        // file boundaries and zip by position. On a mismatch (e.g. a filename
        // that defeats the boundary split), degrade to empty previews.
        let previews = diff.stdout.split(/\ndiff --git a\//).map((chunk, index) => (index === 0 ? chunk : `diff --git a/${chunk}`));
        if (previews[0]?.startsWith("diff --git a/") !== true) previews = previews.slice(1);
        if (previews.length !== paths.length) previews = paths.map(() => "");
        const collected: Array<Omit<AgentRunFile, "id">> = numstats.map((entry, index) => {
          const code = statusByPath.get(entry.path) ?? "";
          return {
            path: entry.path,
            changeKind: code.includes("D") ? "delete" : code.includes("?") || code.includes("A") ? "add" : "update",
            additions: entry.additions,
            deletions: entry.deletions,
            summary: null,
            diffPreview: previews[index].slice(0, 20_000),
          };
        });
        await replaceRunFiles(runId, collected, this.env.DB);
        const completeDiff = await sandbox.exec("git diff --no-color --binary HEAD", { cwd: "/workspace/repository", timeout: 60_000 });
        const boundedDiff = completeDiff.stdout.slice(0, MAX_DIFF_BYTES);
        const diffKey = `runs/${runId}/changes.diff`;
        await this.env.PREFLIGHT_LOGS.put(diffKey, boundedDiff, { httpMetadata: { contentType: "text/x-diff; charset=utf-8" } });
        await recordRunArtifact(runId, "diff", diffKey, "text/x-diff; charset=utf-8", boundedDiff.length, this.env.DB);
        await this.notify(runId);
        return collected;
      });

      for (const check of context.checks) {
        if (await isRunCancellationRequested(runId, this.env.DB)) {
          finalStatus = "cancelled";
          summary = "Agent run cancelled during required checks. No repository changes were published.";
          return await this.complete(runId, finalStatus, summary);
        }
        const checkResult = await step.do(`run check ${check.position + 1}`, { retries: { limit: 0, delay: "1 second" }, timeout: "11 minutes" }, async () => {
          await markRunCheckRunning(runId, check.id, this.env.DB);
          await this.notify(runId);
          const startedAt = Date.now();
          try {
            const execution = await sandbox.exec(check.command, { cwd: "/workspace/repository", timeout: COMMAND_TIMEOUT_MS });
            const log = bounded(execution.stdout, execution.stderr, MAX_LOG_BYTES);
            const logKey = `runs/${runId}/checks/${check.position}.log`;
            await this.env.PREFLIGHT_LOGS.put(logKey, log, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
            const status = execution.success ? "passed" : "failed";
            await finishRunCheck(runId, check.id, { status, exitCode: execution.exitCode, durationMs: Date.now() - startedAt, outputExcerpt: log, logKey }, this.env.DB);
            await this.notify(runId);
            return { status, exitCode: execution.exitCode } as const;
          } catch (error) {
            const timedOut = String(error).toLowerCase().includes("timeout");
            const log = bounded("", error instanceof Error ? error.message : "Required check failed", MAX_LOG_BYTES);
            const logKey = `runs/${runId}/checks/${check.position}.log`;
            await this.env.PREFLIGHT_LOGS.put(logKey, log, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
            await finishRunCheck(runId, check.id, { status: timedOut ? "timed_out" : "failed", exitCode: null, durationMs: Date.now() - startedAt, outputExcerpt: log, logKey }, this.env.DB);
            await this.notify(runId);
            return { status: timedOut ? "timed_out" : "failed", exitCode: null } as const;
          }
        });
        if (checkResult.status !== "passed") {
          finalStatus = "failed";
          summary = checkResult.status === "timed_out" ? `Required check ${check.position + 1} timed out.` : `Required check ${check.position + 1} failed.`;
          return await this.complete(runId, finalStatus, summary);
        }
      }
      if (await isRunCancellationRequested(runId, this.env.DB)) {
        finalStatus = "cancelled";
        summary = "Agent run cancelled after required checks. No repository changes were published.";
        return await this.complete(runId, finalStatus, summary);
      }
      finalStatus = "ready";
      summary = context.checks.length > 0
        ? `The agent changed ${files.length} file${files.length === 1 ? "" : "s"}; all required checks passed. Preparing the verified run branch.`
        : `The agent changed ${files.length} file${files.length === 1 ? "" : "s"}; no check commands were configured. Preparing the verified run branch.`;
      await this.complete(runId, finalStatus, summary);

      const bundle = await step.do("export run bundle", { retries: { limit: 1, delay: "5 seconds" }, timeout: "5 minutes" }, async () => {
        if (!context.runBranch) throw new Error("Run branch was not generated");
        const uploadToken = await signRunGatewayToken({
          runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
          candidateSha: context.candidateSha, operation: "bundle_upload",
        }, this.env.RUNTIME_GATEWAY_SECRET);
        const result = await sandbox.exec(
          `git -c core.hooksPath=/dev/null add -A &&
           git -c core.hooksPath=/dev/null commit -q -m "openfloor local run $OPENFLOOR_RUN_SHORT" &&
           git update-ref "refs/heads/$OPENFLOOR_RUN_BRANCH" HEAD &&
           git bundle create /tmp/openfloor/result.bundle "refs/heads/$OPENFLOOR_RUN_BRANCH" ^refs/heads/openfloor-base &&
           curl --fail --silent --show-error --max-time 300 -X POST -H "Authorization: Bearer $OPENFLOOR_BUNDLE_TOKEN" -H "Content-Type: application/x-git-bundle" --data-binary @/tmp/openfloor/result.bundle "$OPENFLOOR_BUNDLE_URL" >/tmp/openfloor/bundle-response.json &&
           printf '%s %s' "$(git rev-parse HEAD)" "$(wc -c </tmp/openfloor/result.bundle)"`,
          { cwd: "/workspace/repository", timeout: 4 * 60 * 1000, env: {
            OPENFLOOR_RUN_BRANCH: context.runBranch,
            OPENFLOOR_RUN_SHORT: runId.slice(0, 8),
            OPENFLOOR_BUNDLE_TOKEN: uploadToken,
            OPENFLOOR_BUNDLE_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/run/bundle`,
          } },
        );
        if (!result.success) throw new Error("Run bundle export failed");
        const [localCommitSha, sizeValue] = result.stdout.trim().split(/\s+/);
        const bundleSizeBytes = Number(sizeValue);
        if (!/^[0-9a-f]{40}$/.test(localCommitSha) || !Number.isSafeInteger(bundleSizeBytes)) throw new Error("Run bundle export returned invalid metadata");
        const bundleKey = `runs/${runId}/result.bundle`;
        await markRunPublishing(runId, { bundleKey, bundleSizeBytes, localCommitSha }, this.env.DB);
        await this.notify(runId);
        return { bundleKey, bundleSizeBytes, localCommitSha };
      });

      const published = await this.publishBundle(runId, context, files, bundle, publisher, step);
      const completion = await finishRunPublished(runId, published.commitSha, published.remoteSha, this.env.DB);
      if (completion) await notifyFloorChanged(completion.sessionId, completion.revision, ["queue", "runs", "review"]);
      return await this.integrate(runId, step);
    } catch (error) {
      const current = await getRunExecutionContext(runId, this.env.DB);
      if (current && ["ready", "publishing"].includes(current.status)) {
        const failure = await recordRunPublicationFailure(runId, error instanceof Error ? error.message : "Run publication failed.", this.env.DB);
        if (failure) await notifyFloorChanged(failure.sessionId, failure.revision, ["queue", "runs", "review"]);
        return { status: current.status === "publishing" ? "publishing" : "failed" };
      }
      finalStatus = await isRunCancellationRequested(runId, this.env.DB) ? "cancelled" : "failed";
      summary = finalStatus === "cancelled" ? "Agent run cancelled. No repository changes were published." : error instanceof Error ? error.message : "Agent run failed.";
      return await this.complete(runId, finalStatus, summary);
    } finally {
      const claimed = pooled;
      if (claimed) {
        try {
          await step.do("release run sandbox", { retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" }, async () => {
            // Re-fetch the stub with keepAlive off and a sleep backstop: if the
            // eviction sweep ever stalls, the container still self-stops instead
            // of billing forever. The pool sweep remains the primary reaper.
            const parked = getSandbox(this.env.SANDBOX, claimed.id, {
              keepAlive: false,
              sleepAfter: "20m",
              enableDefaultSession: false,
              normalizeId: true,
            });
            await parked.killAllProcesses();
            // Hard reset between runs: wipe the workspace, run scratch, and
            // Codex state; only the npm cache survives for the next claim.
            const reset = await parked.exec("rm -rf /workspace/repository /tmp/openfloor ~/.codex", { timeout: 60_000 });
            if (!reset.success) throw new Error(`Sandbox reset failed with exit code ${reset.exitCode}`);
            await releasePoolSandbox(claimed.id, this.env.DB);
          });
        } catch {
          // A sandbox that cannot be verifiably reset must not be reused.
          try {
            await step.do("retire run sandbox", { retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" }, async () => {
              await claimed.sandbox.destroy();
              await retirePoolSandbox(claimed.id, this.env.DB);
            });
          } catch {
            // Row stays claimed; the eviction sweep reaps abandoned claims.
          }
        }
      }
      try {
        await step.do("destroy publisher sandbox", { retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" }, async () => publisher.destroy());
      } catch {
        // The trusted publisher contains no reusable credentials after its process exits.
      }
    }
  }

  private async notify(runId: string) {
    const update = await bumpAgentRunRevision(runId, this.env.DB);
    if (update) await notifyFloorChanged(update.sessionId, update.revision, ["queue", "runs", "review"]);
  }

  private async integrate(runId: string, step: WorkflowStep): Promise<{ status: string }> {
    try {
      const result = await step.do("serialize and integrate run", { retries: { limit: 20, delay: "5 seconds", backoff: "exponential" }, timeout: "20 minutes" }, async () => {
        // Checked on every attempt (not just once) so a cancellation requested
        // between retries is honored instead of waiting out the full backoff.
        if (await isRunCancellationRequested(runId, this.env.DB)) throw new NonRetryableError("Integration cancelled");
        const context = await beginRunIntegration(runId, this.env.DB);
        const config = getGitHubAppConfig();
        const repository: GitHubRepositoryOption = {
          id: context.repositoryId, nodeId: "integration-not-required", owner: context.repositoryOwner,
          name: context.repositoryName, fullName: context.repositoryFullName, private: true, defaultBranch: context.baseBranch,
        };
        const [candidateSha, runSha, baseSha] = await Promise.all([
          getRepositoryRefSha(config, context.installationId, repository, context.candidateBranch),
          getRepositoryRefSha(config, context.installationId, repository, context.runBranch),
          getRepositoryRefSha(config, context.installationId, repository, context.baseBranch),
        ]);
        if (!/^[0-9a-f]{40}$/.test(candidateSha) || !/^[0-9a-f]{40}$/.test(baseSha) || runSha !== context.runCommitSha) {
          throw new Error("GitHub refs changed before serialized integration");
        }
        try {
          const merged = await mergeRepositoryBranch(
            config, context.installationId, repository, context.candidateBranch, context.runCommitSha,
            `Integrate openfloor run ${runId.slice(0, 8)}`,
          );
          const reconciled = await getRepositoryRefSha(config, context.installationId, repository, context.candidateBranch);
          if (reconciled !== merged.sha) throw new Error("Candidate branch did not reconcile after integration");
          const pullRequest = context.pullRequestNumber ? null : await createDraftPullRequest(config, context.installationId, repository, {
            title: context.candidateName,
            body: context.candidateDescription,
            head: context.candidateBranch,
            base: context.baseBranch,
          });
          return { conflicted: false as const, candidateSha: reconciled, pullRequest };
        } catch (error) {
          if (error instanceof GitHubApiError && error.status === 409) return { conflicted: true as const, reason: error.message };
          throw error;
        }
      });
      if (result.conflicted) {
        const update = await markRunIntegrationConflicted(runId, result.reason, this.env.DB);
        if (update) {
          await notifyFloorChanged(update.sessionId, update.revision, ["queue", "repository", "runs", "review"]);
          await pokeSessionRouter(update.sessionId, "run_completed");
        }
        return { status: "conflicted" };
      }
      const update = await finishRunIntegrated(runId, result.candidateSha, result.pullRequest, this.env.DB);
      if (update) {
        await notifyFloorChanged(update.sessionId, update.revision, ["queue", "repository", "runs", "review"]);
        await pokeSessionRouter(update.sessionId, "run_completed");
      }
      return { status: "integrated" };
    } catch (error) {
      if (await isRunCancellationRequested(runId, this.env.DB)) {
        const cancelled = await cancelRunIntegration(runId, this.env.DB);
        if (cancelled) {
          await notifyFloorChanged(cancelled.sessionId, cancelled.revision, ["queue", "repository", "runs", "review"]);
          await pokeSessionRouter(cancelled.sessionId, "run_completed");
        }
        return { status: "cancelled" };
      }
      const reason = error instanceof Error ? error.message : "Candidate integration failed";
      const update = await releaseRunIntegration(runId, reason, this.env.DB);
      if (update) await notifyFloorChanged(update.sessionId, update.revision, ["queue", "repository", "runs", "review"]);
      return { status: "published" };
    }
  }

  private async publishBundle(
    runId: string,
    context: NonNullable<Awaited<ReturnType<typeof getRunExecutionContext>>>,
    files: Array<{ path: string }>,
    bundle: { localCommitSha: string },
    publisher: Sandbox,
    step: WorkflowStep,
  ) {
    return step.do("validate and publish run branch", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "20 minutes" }, async () => {
      if (!context.runBranch) throw new Error("Run branch was not generated");
      const config = getGitHubAppConfig();
      const githubToken = await createInstallationToken(config, context.installationId, context.repositoryId);
      const bundleToken = await signRunGatewayToken({
        runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
        candidateSha: context.candidateSha, operation: "bundle_read",
      }, this.env.RUNTIME_GATEWAY_SECRET);
      const bundlePath = `/tmp/openfloor-${runId}.bundle`;
      const resultPath = `/tmp/openfloor-${runId}.json`;
      const download = await publisher.exec(
        `curl --fail --silent --show-error --max-time 300 -H "Authorization: Bearer $OPENFLOOR_BUNDLE_TOKEN" "$OPENFLOOR_BUNDLE_URL" -o "$OPENFLOOR_BUNDLE_PATH" &&
         node /opt/openfloor/publish-bundle.mjs`,
        { timeout: 18 * 60 * 1000, env: {
          OPENFLOOR_BUNDLE_TOKEN: bundleToken,
          OPENFLOOR_BUNDLE_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/run/bundle`,
          OPENFLOOR_BUNDLE_PATH: bundlePath,
          OPENFLOOR_PUBLISH_ROOT: `/workspace/publisher-${runId}`,
          OPENFLOOR_REPOSITORY_URL: `https://github.com/${context.repositoryOwner}/${context.repositoryName}.git`,
          OPENFLOOR_GITHUB_TOKEN: githubToken,
          OPENFLOOR_CANDIDATE_BRANCH: context.candidateBranch,
          OPENFLOOR_CANDIDATE_SHA: context.candidateSha,
          OPENFLOOR_RUN_BRANCH: context.runBranch,
          OPENFLOOR_EXPECTED_PATHS: JSON.stringify(files.map((file) => file.path)),
          OPENFLOOR_RESULT_PATH: resultPath,
          OPENFLOOR_COMMIT_DATE: new Date(context.createdAt).toISOString(),
          OPENFLOOR_RUN_ID: runId,
        } },
      );
      if (!download.success) throw new Error(`Trusted bundle publication failed: ${download.stderr.slice(-1_000)}`);
      const resultFile = await publisher.exec(`cat "$OPENFLOOR_RESULT_PATH"`, { timeout: 10_000, env: { OPENFLOOR_RESULT_PATH: resultPath } });
      const parsed = JSON.parse(resultFile.stdout) as { localCommit?: string; publishedCommit?: string };
      if (parsed.localCommit !== bundle.localCommitSha || !parsed.publishedCommit || !/^[0-9a-f]{40}$/.test(parsed.publishedCommit)) {
        throw new Error("Trusted publisher returned inconsistent commit metadata");
      }
      const repository: GitHubRepositoryOption = {
        id: context.repositoryId, nodeId: "workflow-not-required", owner: context.repositoryOwner,
        name: context.repositoryName, fullName: context.repositoryFullName, private: true, defaultBranch: context.candidateBranch,
      };
      const remoteSha = await getRepositoryRefSha(config, context.installationId, repository, context.runBranch);
      if (remoteSha !== parsed.publishedCommit) throw new Error("Published run branch did not reconcile with GitHub");
      return { commitSha: parsed.publishedCommit, remoteSha };
    });
  }

  private async complete(runId: string, status: "ready" | "failed" | "cancelled", summary: string) {
    const completion = await finishAgentRun(runId, status, summary, this.env.DB);
    if (completion) {
      await notifyFloorChanged(completion.sessionId, completion.revision, ["queue", "runs", "review"]);
      // The run left its active status; freed capacity may unblock the router.
      await pokeSessionRouter(completion.sessionId, "run_completed");
    }
    return { status };
  }
}

// Renders the unified session brief: everything getSessionContext knows about
// the floor right now, plus this run's own pinned identity (agent, attempt,
// candidate SHA) as the viewer. See lib/session-context.ts for the rendered
// template and the rationale for what is and isn't included (direct messages
// never are).
async function buildRunPrompt(context: NonNullable<Awaited<ReturnType<typeof getRunExecutionContext>>>, database: D1DatabaseLike): Promise<string> {
  const snapshot = await getSessionContext(context.sessionId, { runId: context.id, queueItemId: context.queueItemId }, database);
  if (!snapshot) throw new Error("Session context is unavailable for this run");
  return renderSessionContext(snapshot, viewerFromRunContext(context));
}

function parseCodexResult(value: string): { ok: boolean; threadId: string | null; finalResponse: string | null; error: string | null } {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      ok: parsed.ok === true,
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
      finalResponse: typeof parsed.finalResponse === "string" ? parsed.finalResponse.slice(0, 20_000) : null,
      error: typeof parsed.error === "string" ? parsed.error.slice(0, 1_000) : null,
    };
  } catch {
    return { ok: false, threadId: null, finalResponse: null, error: "The agent did not produce a valid result" };
  }
}

function bounded(stdout: string, stderr: string, limit: number): string {
  const combined = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`;
  if (combined.length <= limit) return combined;
  const half = Math.floor((limit - 80) / 2);
  return `${combined.slice(0, half)}\n\n[openfloor truncated output]\n\n${combined.slice(-half)}`;
}

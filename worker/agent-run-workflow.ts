import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1DatabaseLike } from "../db";
import {
  bumpAgentRunRevision,
  beginRunIntegration,
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
} from "../db/runs";
import { getGitHubAppConfig } from "../db";
import { createDraftPullRequest, createInstallationToken, getRepositoryRefSha, GitHubApiError, mergeRepositoryBranch } from "../lib/github";
import type { AgentRunFile } from "../lib/floor-types";
import type { GitHubRepositoryOption } from "../lib/session-types";
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

export class AgentRunWorkflow extends WorkflowEntrypoint<AgentRunWorkflowEnv, Params> {
  async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<{ status: string }> {
    const runId = event.payload.runId;
    const context = await step.do("load run", async () => {
      const value = await getRunExecutionContext(runId, this.env.DB);
      if (!value) throw new Error("Agent run no longer exists");
      return value;
    });
    const sandbox = getSandbox(this.env.SANDBOX, context.sandboxId, {
      keepAlive: true,
      enableDefaultSession: false,
      normalizeId: true,
      labels: { sessionId: context.sessionId, runId },
    });
    const publisher = getSandbox(this.env.SANDBOX, `publisher-${PUBLISHER_SANDBOX_IMAGE_VERSION}-${event.instanceId}`, {
      keepAlive: true,
      enableDefaultSession: false,
      normalizeId: true,
      labels: { sessionId: context.sessionId, runId, purpose: "trusted-publisher" },
    });
    let finalStatus: "ready" | "failed" | "cancelled" = "failed";
    let summary = "Agent run failed before Codex completed.";
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
      await step.do("prepare exact workspace", { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
        const sourceToken = await signRunGatewayToken({
          runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
          candidateSha: context.candidateSha, operation: "source",
        }, this.env.RUNTIME_GATEWAY_SECRET);
        const result = await sandbox.exec(
          `mkdir -p /workspace/repository /tmp/openfloor && find /workspace/repository -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + &&
           curl --fail --silent --show-error --location --max-filesize 104857600 -H "Authorization: Bearer $OPENFLOOR_SOURCE_TOKEN" "$OPENFLOOR_SOURCE_URL" |
             tar -xz --strip-components=1 -C /workspace/repository &&
           git -C /workspace/repository init -q && git -C /workspace/repository config user.name OpenFloor &&
           git -C /workspace/repository config user.email runtime@opnflr.com && git -C /workspace/repository add -A &&
           OPENFLOOR_TREE=$(git -C /workspace/repository write-tree) &&
           OPENFLOOR_BASE=$(printf 'OpenFloor candidate baseline\n' | env GIT_AUTHOR_NAME=OpenFloor GIT_AUTHOR_EMAIL=runtime@opnflr.com GIT_COMMITTER_NAME=OpenFloor GIT_COMMITTER_EMAIL=runtime@opnflr.com GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git -C /workspace/repository commit-tree "$OPENFLOOR_TREE") &&
           git -C /workspace/repository update-ref refs/heads/openfloor-base "$OPENFLOOR_BASE" &&
           git -C /workspace/repository reset -q --hard "$OPENFLOOR_BASE"`,
          { timeout: 4 * 60 * 1000, env: {
            OPENFLOOR_SOURCE_TOKEN: sourceToken,
            OPENFLOOR_SOURCE_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/run/source`,
          } },
        );
        if (!result.success) throw new Error(`Candidate workspace preparation failed with exit code ${result.exitCode}`);
        await sandbox.writeFile("/tmp/openfloor/prompt.txt", buildRunPrompt(context));
      });

      const processId = `codex-${runId}`;
      await step.do("start Codex", { retries: { limit: 1, delay: "5 seconds" }, timeout: "2 minutes" }, async () => {
        const existing = await sandbox.getProcess(processId);
        if (!existing) {
          const openaiToken = await signRunGatewayToken({
            runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
            candidateSha: context.candidateSha, operation: "openai",
          }, this.env.RUNTIME_GATEWAY_SECRET);
          const eventsToken = await signRunGatewayToken({
            runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
            candidateSha: context.candidateSha, operation: "events",
          }, this.env.RUNTIME_GATEWAY_SECRET);
          await sandbox.startProcess("node /opt/openfloor/codex-runner.mjs", {
            processId,
            autoCleanup: false,
            cwd: "/workspace/repository",
            env: {
              OPENFLOOR_PROMPT_PATH: "/tmp/openfloor/prompt.txt",
              OPENFLOOR_RESULT_PATH: "/tmp/openfloor/result.json",
              OPENFLOOR_WORKSPACE: "/workspace/repository",
              OPENFLOOR_OPENAI_BASE_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/openai/v1`,
              OPENFLOOR_OPENAI_TOKEN: openaiToken,
              OPENFLOOR_MODEL: context.model,
              OPENFLOOR_EVENTS_URL: `${this.env.OPENFLOOR_RUNTIME_ORIGIN}/runtime/run/events`,
              OPENFLOOR_EVENTS_TOKEN: eventsToken,
            },
          });
        }
        await setRunProcessId(runId, processId, this.env.DB);
        await markRunRunning(runId, processId, this.env.DB);
        await this.notify(runId);
      });

      const processResult = await step.do("wait for Codex", { retries: { limit: 1, delay: "10 seconds" }, timeout: "60 minutes" }, async () => {
        const process = await sandbox.getProcess(processId);
        if (!process) throw new Error("Codex process could not be recovered");
        for (;;) {
          if (await isRunCancellationRequested(runId, this.env.DB)) {
            await process.kill("SIGTERM");
            return { cancelled: true, exitCode: 130, stdout: "", stderr: "Agent run cancelled." };
          }
          const status = await process.getStatus();
          if (["completed", "failed", "killed", "error"].includes(status)) {
            const logs = await process.getLogs();
            return { cancelled: status === "killed", exitCode: process.exitCode ?? (status === "completed" ? 0 : 1), ...logs };
          }
          await delay(2_000);
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
      if (processResult.exitCode !== 0 || !codexResult.ok) throw new Error(codexResult.error || `Codex exited with code ${processResult.exitCode}`);
      await markRunChecking(runId, codexResult.threadId, codexResult.finalResponse, this.env.DB);
      await this.notify(runId);

      const files = await step.do("collect changed files", { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" }, async () => {
        await sandbox.exec("git add -N .", { cwd: "/workspace/repository", timeout: 30_000 });
        const names = await sandbox.exec("git diff --name-only -z HEAD", { cwd: "/workspace/repository", timeout: 30_000 });
        if (!names.success) throw new Error("Unable to enumerate Codex changes");
        const paths = names.stdout.split("\0").filter(Boolean);
        if (paths.length === 0) throw new Error("Codex completed without changing any files");
        if (paths.length > MAX_FILES) throw new Error(`Codex changed more than ${MAX_FILES} files`);
        if (paths.some((path) => path === ".github/workflows" || path.startsWith(".github/workflows/"))) {
          throw new Error("Workflow-file changes are not allowed in this release");
        }
        const collected: Array<Omit<AgentRunFile, "id">> = [];
        for (const path of paths) {
          const [statusResult, stats, diff] = await Promise.all([
            sandbox.exec("git status --short -- \"$OPENFLOOR_FILE\"", { cwd: "/workspace/repository", timeout: 30_000, env: { OPENFLOOR_FILE: path } }),
            sandbox.exec("git diff --numstat HEAD -- \"$OPENFLOOR_FILE\"", { cwd: "/workspace/repository", timeout: 30_000, env: { OPENFLOOR_FILE: path } }),
            sandbox.exec("git diff --no-color --unified=3 HEAD -- \"$OPENFLOOR_FILE\"", { cwd: "/workspace/repository", timeout: 30_000, env: { OPENFLOOR_FILE: path } }),
          ]);
          const [additions, deletions] = stats.stdout.trim().split("\t").slice(0, 2).map((value) => Number(value) || 0);
          const code = statusResult.stdout.slice(0, 2);
          collected.push({
            path,
            changeKind: code.includes("D") ? "delete" : code.includes("?") || code.includes("A") ? "add" : "update",
            additions,
            deletions,
            summary: null,
            diffPreview: diff.stdout.slice(0, 20_000),
          });
        }
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
      summary = `Codex changed ${files.length} file${files.length === 1 ? "" : "s"}; all required checks passed. Preparing the verified run branch.`;
      await this.complete(runId, finalStatus, summary);

      const bundle = await step.do("export run bundle", { retries: { limit: 1, delay: "5 seconds" }, timeout: "5 minutes" }, async () => {
        if (!context.runBranch) throw new Error("Run branch was not generated");
        const uploadToken = await signRunGatewayToken({
          runId, sessionId: context.sessionId, repositoryId: context.repositoryId,
          candidateSha: context.candidateSha, operation: "bundle_upload",
        }, this.env.RUNTIME_GATEWAY_SECRET);
        const result = await sandbox.exec(
          `git -c core.hooksPath=/dev/null add -A &&
           git -c core.hooksPath=/dev/null commit -q -m "OpenFloor local run $OPENFLOOR_RUN_SHORT" &&
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
      try {
        await step.do("destroy run sandbox", { retries: { limit: 2, delay: "5 seconds" }, timeout: "2 minutes" }, async () => sandbox.destroy());
      } catch {
        // The run is already terminal; platform cleanup can retry independently.
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
            `Integrate OpenFloor run ${runId.slice(0, 8)}`,
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

function buildRunPrompt(context: NonNullable<Awaited<ReturnType<typeof getRunExecutionContext>>>): string {
  const prompts = context.prompts.map((prompt, index) => `${index + 1}. ${prompt.authorName}: ${prompt.text}`).join("\n");
  return `You are ${context.agentName}, the ${context.agentRole} agent in the OpenFloor session "${context.sessionTitle}".\n\nSession objective:\n${context.objective ?? "No objective provided."}\n\nYour assigned responsibility:\n${context.agentTask}\n\nQueue request(s):\n${prompts}\n\nRepository: ${context.repositoryFullName}\nPinned candidate SHA: ${context.candidateSha}\n\nMake the requested code changes directly in the current workspace. Read and follow repository instructions such as AGENTS.md. Do not modify files under .github/workflows/. Do not commit, push, create branches, contact GitHub, or claim work that you did not perform. Keep the change focused and leave the workspace ready for the configured checks.`;
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
    return { ok: false, threadId: null, finalResponse: null, error: "Codex did not produce a valid result" };
  }
}

function bounded(stdout: string, stderr: string, limit: number): string {
  const combined = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`;
  if (combined.length <= limit) return combined;
  const half = Math.floor((limit - 80) / 2);
  return `${combined.slice(0, half)}\n\n[OpenFloor truncated output]\n\n${combined.slice(-half)}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

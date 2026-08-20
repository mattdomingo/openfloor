import { env } from "cloudflare:workers";
import {
  createRepositoryPreflight,
  finishPreflightCheck,
  finishRepositoryPreflight,
  getLatestRepositoryPreflightForMember,
  getPreflightExecutionContext,
  markPreflightCheckRunning,
  markPreflightLaunchFailed,
  markPreflightRunning,
  PreflightConflictError,
  PreflightNotReadyError,
} from "@/db/preflights";
import { getRepositoryFloorRevision } from "@/db/repositories";
import { getMembershipRole } from "@/db/sessions";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

type WorkflowBinding = { create(options: { id: string; params: { preflightId: string } }): Promise<unknown> };
type R2BucketLike = { put(key: string, value: string, options?: unknown): Promise<unknown> };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  if (!(await getMembershipRole(sessionId, user.id))) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({ preflight: await getLatestRepositoryPreflightForMember(sessionId, user.id) });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  if ((env as unknown as { PREFLIGHT_ENABLED?: string }).PREFLIGHT_ENABLED !== "true") {
    return Response.json({ error: "Repository preflight is not available" }, { status: 503 });
  }
  try {
    const preflight = await createRepositoryPreflight(sessionId, user.id);
    await notifyFloorChanged(sessionId, await getRepositoryFloorRevision(sessionId), ["repository", "review"]);
    const bindings = env as unknown as {
      REPOSITORY_PREFLIGHT?: WorkflowBinding;
      PREFLIGHT_LOGS?: R2BucketLike;
      OPENFLOOR_TEST_PREFLIGHT_DATA?: string;
      OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string;
    };
    if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true" && bindings.OPENFLOOR_TEST_PREFLIGHT_DATA && bindings.PREFLIGHT_LOGS) {
      await runTestPreflight(preflight.id, bindings.OPENFLOOR_TEST_PREFLIGHT_DATA, bindings.PREFLIGHT_LOGS);
    } else {
      if (!bindings.REPOSITORY_PREFLIGHT) throw new Error("Repository preflight Workflow binding is unavailable");
      await bindings.REPOSITORY_PREFLIGHT.create({ id: preflight.id, params: { preflightId: preflight.id } });
    }
    return Response.json({ preflight: await getLatestRepositoryPreflightForMember(sessionId, user.id) }, { status: 202 });
  } catch (error) {
    try { return mutationErrorResponse(error); } catch { /* continue with preflight mapping */ }
    if (error instanceof PreflightConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof PreflightNotReadyError) return Response.json({ error: error.message }, { status: error.message === "Session not found" ? 404 : 409 });
    const latest = await getLatestRepositoryPreflightForMember(sessionId, user.id);
    if (latest?.status === "provisioning") await markPreflightLaunchFailed(latest.id, "Repository preflight could not be started");
    return Response.json({ error: "Repository preflight could not be started" }, { status: 502 });
  }
}

async function runTestPreflight(preflightId: string, encoded: string, logs: R2BucketLike): Promise<void> {
  const configured = JSON.parse(encoded) as { checks?: Array<{ exitCode?: number; stdout?: string; stderr?: string }>; failCommands?: string[] };
  const context = await getPreflightExecutionContext(preflightId);
  if (!context) throw new Error("Test preflight context is missing");
  await markPreflightRunning(preflightId);
  let passed = true;
  for (const check of context.checks) {
    const result = configured.failCommands?.includes(check.command)
      ? { exitCode: 1, stderr: "check failed\n" }
      : configured.checks?.[check.position] ?? { exitCode: 0, stdout: "check passed\n" };
    const exitCode = result.exitCode ?? 0;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const logKey = `preflights/${preflightId}/checks/${check.position}.log`;
    await markPreflightCheckRunning(preflightId, check.id);
    await logs.put(logKey, output);
    await finishPreflightCheck(preflightId, check.id, {
      status: exitCode === 0 ? "passed" : "failed",
      exitCode,
      durationMs: 1,
      outputExcerpt: output.slice(-2000),
      logKey,
    });
    if (exitCode !== 0) { passed = false; break; }
  }
  const completion = await finishRepositoryPreflight(preflightId, passed ? "passed" : "failed", passed ? "All required checks passed." : "A required check failed.");
  if (completion) await notifyFloorChanged(completion.sessionId, completion.revision, ["repository", "review"]);
}

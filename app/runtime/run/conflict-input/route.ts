import { recordConflictAssessment } from "@/db/conflict-decisions";
import { requestConflictInput } from "@/db/conflicts";
import { getRunGatewayContext } from "@/db/runs";
import { notifyFloorChanged } from "@/lib/presence-server";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { parseConflictInputRequest, parseConflictAssessment } from "@/lib/validation";
import { readJson } from "@/lib/floor-api";
import { env } from "cloudflare:workers";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const secret = (env as unknown as { RUNTIME_GATEWAY_SECRET?: string }).RUNTIME_GATEWAY_SECRET;
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !secret) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, secret, "conflict_input");
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getRunGatewayContext(claims.runId);
  if (!context || !context.conflictCaseId || context.sessionId !== claims.sessionId
    || context.repositoryId !== claims.repositoryId || context.candidateSha !== claims.candidateSha
    || !["provisioning", "running", "checking"].includes(context.status)) {
    return new Response("Not found", { status: 404 });
  }
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body) return new Response("Invalid or oversized payload", { status: 400 });
  const assessment = parseConflictAssessment(body);
  if (assessment) {
    const recorded = await recordConflictAssessment(claims.runId, assessment);
    if (!recorded) return Response.json({ error: "The report must cover both intents and current approvals. Request human input if evidence is incomplete." }, { status: 409 });
    if (assessment.outcome !== "compatible") {
      const waiting = await requestConflictInput(claims.runId, assessment.explanation, []);
      if (waiting) await notifyFloorChanged(waiting.sessionId, waiting.revision, ["queue", "runs", "review"]);
    }
    return Response.json({ accepted: true }, { status: 202 });
  }
  const input = parseConflictInputRequest(body);
  if (!input) return Response.json({ error: "Provide a bounded explanation and one to three questions." }, { status: 400 });
  const result = await requestConflictInput(claims.runId, input.explanation, input.questions);
  if (!result || result.sessionId !== claims.sessionId) return new Response("Not found", { status: 404 });
  await notifyFloorChanged(result.sessionId, result.revision, ["queue", "runs", "review"]);
  return Response.json({ accepted: true, caseId: result.caseId }, { status: 202 });
}

import { requestConflictInput } from "@/db/conflicts";
import { getRunGatewayContext } from "@/db/runs";
import { notifyFloorChanged } from "@/lib/presence-server";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { parseConflictInputRequest } from "@/lib/validation";
import { env } from "cloudflare:workers";

const MAX_BODY_BYTES = 16 * 1024;

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
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  const raw = await request.arrayBuffer();
  if (raw.byteLength === 0 || raw.byteLength > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  const input = parseConflictInputRequest(body);
  if (!input) return Response.json({ error: "Provide a bounded explanation and one to three questions." }, { status: 400 });
  const result = await requestConflictInput(claims.runId, input.explanation, input.questions);
  if (!result || result.sessionId !== claims.sessionId) return new Response("Not found", { status: 404 });
  await notifyFloorChanged(result.sessionId, result.revision, ["queue", "runs", "review"]);
  return Response.json({ accepted: true, caseId: result.caseId }, { status: 202 });
}

import { countRunnerActivityEvents, getRunExecutionContext, insertRunActivityEvents, MAX_RUNNER_EVENTS_PER_RUN, RUNNER_SEQUENCE_BASE } from "@/db/runs";
import { notifyRunActivity } from "@/lib/presence-server";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENTS_PER_POST = 50;
const RUNNER_EVENT_KINDS = new Set(["reasoning", "command", "file_edit", "agent_message", "error", "truncated"]);

type IncomingEvent = { sequence: number; kind: string; detail: string };

export async function POST(request: Request) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string };
  const token = bearer(request);
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "events");
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getRunExecutionContext(claims.runId);
  if (!context || !matches(context, claims) || !["running", "cancel_requested"].includes(context.status)) {
    return new Response("Not found", { status: 404 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  const raw = await request.arrayBuffer();
  if (raw.byteLength === 0 || raw.byteLength > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
  let body: { events?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as { events?: unknown };
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS_PER_POST || !body.events.every(validEvent)) {
    return new Response("Invalid payload", { status: 400 });
  }
  const existing = await countRunnerActivityEvents(claims.runId);
  if (existing >= MAX_RUNNER_EVENTS_PER_RUN) return Response.json({ accepted: 0, stop: true });
  const events = (body.events as IncomingEvent[]).slice(0, MAX_RUNNER_EVENTS_PER_RUN - existing)
    .map((event) => ({ sequence: event.sequence, kind: event.kind, detail: event.detail.slice(0, 2_000) }));
  const inserted = await insertRunActivityEvents(claims.runId, events);
  if (inserted.length > 0) {
    await notifyRunActivity(context.sessionId, { runId: claims.runId, agentId: context.agentId, events: inserted });
  }
  return Response.json({ accepted: inserted.length, stop: existing + inserted.length >= MAX_RUNNER_EVENTS_PER_RUN });
}

function validEvent(event: unknown): event is IncomingEvent {
  if (!event || typeof event !== "object") return false;
  const candidate = event as Record<string, unknown>;
  return typeof candidate.sequence === "number" && Number.isSafeInteger(candidate.sequence)
    && candidate.sequence >= RUNNER_SEQUENCE_BASE
    && typeof candidate.kind === "string" && RUNNER_EVENT_KINDS.has(candidate.kind)
    && typeof candidate.detail === "string";
}

function bearer(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? null;
}

function matches(context: Awaited<ReturnType<typeof getRunExecutionContext>>, claims: { sessionId: string; repositoryId: string; candidateSha: string }) {
  return Boolean(context && context.sessionId === claims.sessionId && context.repositoryId === claims.repositoryId && context.candidateSha === claims.candidateSha);
}

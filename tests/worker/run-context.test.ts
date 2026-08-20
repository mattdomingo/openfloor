import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GET as getRunContext } from "@/app/runtime/run/context/route";
import { createFloorAgent, createFloorQueueItem } from "@/db/floor";
import { createSession, upsertUser } from "@/db/sessions";
import { signRunGatewayToken, type RunGatewayClaims } from "@/lib/runtime-token";
import { parseAgentInput, parseQueuePromptInput } from "@/lib/validation";

const SECRET = "worker-test-runtime-gateway-secret";

function identity(id: string, name: string) {
  return { providerUserId: `run-context-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function room(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const created = await createSession(owner.id, { title: `Context ${suffix}`, objective: `Ship ${suffix}.` }, env.DB);
  return { sessionId: created.session.id, owner };
}

async function addAgent(sessionId: string, ownerUserId: string) {
  const input = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement changes", ownerUserId });
  if (!input) throw new Error("Invalid test agent");
  const floor = await createFloorAgent(sessionId, ownerUserId, input, env.DB);
  const agent = floor?.agents.find((candidate) => candidate.name === "Builder");
  if (!agent) throw new Error("Agent was not created");
  return agent.id;
}

async function enqueue(sessionId: string, userId: string, agentId: string, prompt: string) {
  const input = parseQueuePromptInput({ prompt, agentId });
  if (!input) throw new Error("Invalid test prompt");
  const floor = await createFloorQueueItem(sessionId, userId, input, env.DB);
  const item = floor?.queue.find((entry) => entry.agentId === agentId);
  if (!item) throw new Error("Queue item was not created");
  return item.id;
}

/** Mirrors tests/worker/run-activity.test.ts's connection/candidate/run scaffolding. */
async function insertRunRow(sessionId: string, agentId: string, queueItemId: string, userId: string, status: string): Promise<string> {
  const now = Date.now();
  const connection = await env.DB.prepare("SELECT id FROM repository_connections WHERE session_id = ?").bind(sessionId).first<{ id: string }>();
  let connectionId = connection?.id;
  if (!connectionId) {
    connectionId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
       VALUES (?, ?, 'inst', 'repo', 'node', 'owner', 'name', 'owner/name', 1, 'main', 'main', 'ready', ?, ?, ?)`,
    ).bind(connectionId, sessionId, userId, now, now).run();
  }
  const candidate = await env.DB.prepare("SELECT id FROM repository_candidates WHERE session_id = ?").bind(sessionId).first<{ id: string }>();
  let candidateId = candidate?.id;
  if (!candidateId) {
    candidateId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', 'sha-base', 'active', ?, ?, ?)`,
    ).bind(candidateId, sessionId, connectionId, `candidate-${candidateId}`, userId, now, now).run();
  }
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sha-run', 1, ?, 'test-model', 'sandbox', ?, ?, ?)`,
  ).bind(runId, sessionId, queueItemId, agentId, candidateId, status, userId, now, now).run();
  return runId;
}

async function runningRun(suffix: string) {
  const { sessionId, owner } = await room(suffix);
  const agentId = await addAgent(sessionId, owner.id);
  const queueItemId = await enqueue(sessionId, owner.id, agentId, "Add the health check endpoint");
  const runId = await insertRunRow(sessionId, agentId, queueItemId, owner.id, "running");
  return { sessionId, owner, agentId, queueItemId, runId };
}

function contextToken(runId: string, sessionId: string, overrides: Partial<RunGatewayClaims> = {}) {
  return signRunGatewayToken({
    runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "context", ...overrides,
  }, SECRET);
}

function getRequest(token: string) {
  return getRunContext(new Request("http://localhost/runtime/run/context", {
    headers: { authorization: `Bearer ${token}` },
  }));
}

describe("run context gateway route", () => {
  it("renders the same brief a dispatched agent receives, for a live running run", async () => {
    const { sessionId, runId } = await runningRun("live");
    const token = await contextToken(runId, sessionId);
    const response = await getRequest(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toContain("# openfloor session brief");
    expect(text).toContain("You are Builder");
    expect(text).toContain("Owner Example: Add the health check endpoint");
  });

  it("also serves a run that is cancel_requested", async () => {
    const { sessionId, owner } = await room("cancelling");
    const agentId = await addAgent(sessionId, owner.id);
    const queueItemId = await enqueue(sessionId, owner.id, agentId, "Cancel this one");
    const runId = await insertRunRow(sessionId, agentId, queueItemId, owner.id, "cancel_requested");
    const token = await contextToken(runId, sessionId);
    expect((await getRequest(token)).status).toBe(200);
  });

  it("rejects tokens for other operations, mismatched claims, missing runs, and terminal statuses with 404", async () => {
    const { sessionId, runId } = await runningRun("auth");

    const eventsScopedToken = await signRunGatewayToken({ runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "events" }, SECRET);
    expect((await getRequest(eventsScopedToken)).status).toBe(404);

    const mismatched = await contextToken(runId, sessionId, { candidateSha: "sha-other" });
    expect((await getRequest(mismatched)).status).toBe(404);

    const missingRun = await contextToken(crypto.randomUUID(), sessionId);
    expect((await getRequest(missingRun)).status).toBe(404);

    const { sessionId: readySessionId, owner: readyOwner } = await room("terminal");
    const readyAgentId = await addAgent(readySessionId, readyOwner.id);
    const readyQueueItemId = await enqueue(readySessionId, readyOwner.id, readyAgentId, "Already finished");
    const readyRunId = await insertRunRow(readySessionId, readyAgentId, readyQueueItemId, readyOwner.id, "ready");
    const readyToken = await contextToken(readyRunId, readySessionId);
    expect((await getRequest(readyToken)).status).toBe(404);
  });

  it("rejects a missing or malformed bearer token with 404", async () => {
    const response = await getRunContext(new Request("http://localhost/runtime/run/context"));
    expect(response.status).toBe(404);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createFloorAgent } from "@/db/floor";
import { checkProviderBudget } from "@/db/provider-credentials";
import { getQueueItemAgentBudgetContext, recordRunUsage } from "@/db/runs";
import { acceptInvite, createSession, upsertUser } from "@/db/sessions";
import { parseAgentInput } from "@/lib/validation";

function identity(id: string, name: string) {
  return { providerUserId: `run-cost-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function room(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const created = await createSession(owner.id, { title: `Run cost ${suffix}`, objective: null }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  return { sessionId: created.session.id, owner, member };
}

async function agent(sessionId: string, ownerUserId: string, name: string, provider: "anthropic" | "kimi" = "anthropic") {
  const input = parseAgentInput({ name, role: "Engineer", task: "Work", ownerUserId, provider });
  if (!input) throw new Error("Invalid test agent");
  const floor = await createFloorAgent(sessionId, ownerUserId, input, env.DB);
  const created = floor?.agents.find((candidate) => candidate.name === name);
  if (!created) throw new Error("Agent was not created");
  return created.id;
}

/** Minimal running run row — recordRunUsage only needs agent_runs joined to
 * floor_agents. Connection/candidate are unique per session, so a second
 * run in the same session reuses the existing scaffolding. */
async function insertRunRow(sessionId: string, agentId: string, userId: string, model = "claude-sonnet-5"): Promise<string> {
  const now = Date.now();
  let candidateId: string;
  const existing = await env.DB.prepare("SELECT id FROM repository_candidates WHERE session_id = ? AND status = 'active'")
    .bind(sessionId).first<{ id: string }>();
  if (existing) {
    candidateId = existing.id;
  } else {
    const connectionId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
       VALUES (?, ?, 'inst', 'repo', 'node', 'owner', 'name', 'owner/name', 1, 'main', 'main', 'ready', ?, ?, ?)`,
    ).bind(connectionId, sessionId, userId, now, now).run();
    candidateId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', 'sha-base', 'active', ?, ?, ?)`,
    ).bind(candidateId, sessionId, connectionId, `candidate-${candidateId}`, userId, now, now).run();
  }
  const queueItemId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, created_at, updated_at)
     VALUES (?, ?, ?, 999, 'running', ?, ?)`,
  ).bind(queueItemId, sessionId, agentId, now, now).run();
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sha-run', 1, 'running', ?, 'sandbox', ?, ?, ?)`,
  ).bind(runId, sessionId, queueItemId, agentId, candidateId, model, userId, now, now).run();
  return runId;
}

async function setBilledKind(runId: string, kind: "api_key" | "oauth" | "server") {
  await env.DB.prepare("UPDATE agent_runs SET billed_kind = ? WHERE id = ?").bind(kind, runId).run();
}

async function agentRunRow(runId: string) {
  return env.DB.prepare(
    "SELECT input_tokens AS inputTokens, output_tokens AS outputTokens, cost_micro_usd AS costMicroUsd, cost_source AS costSource, billed_kind AS billedKind FROM agent_runs WHERE id = ?",
  ).bind(runId).first<{ inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null; costSource: string | null; billedKind: string | null }>();
}

async function spendRow(userId: string, provider: string, kind: string) {
  const month = new Date().toISOString().slice(0, 7);
  return env.DB.prepare(
    "SELECT micro_usd AS microUsd, input_tokens AS inputTokens, output_tokens AS outputTokens FROM provider_spend_months WHERE user_id = ? AND provider = ? AND kind = ? AND month = ?",
  ).bind(userId, provider, kind, month).first<{ microUsd: number; inputTokens: number; outputTokens: number }>();
}

describe("recordRunUsage", () => {
  it("prices a genuine anthropic run and accumulates the monthly rollup", async () => {
    const { sessionId, owner } = await room("accumulate");
    const agentId = await agent(sessionId, owner.id, "Builder", "anthropic");
    const runId = await insertRunRow(sessionId, agentId, owner.id);
    await setBilledKind(runId, "api_key");

    await recordRunUsage(runId, "anthropic", "claude-sonnet-5", {
      usage: null,
      modelUsage: { "claude-sonnet-5": { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
      totalCostUsd: 0.01,
    }, env.DB);

    const row = await agentRunRow(runId);
    expect(row).toEqual(expect.objectContaining({ inputTokens: 1000, outputTokens: 500, costMicroUsd: 10_000, costSource: "reported", billedKind: "api_key" }));
    const spend = await spendRow(owner.id, "anthropic", "api_key");
    expect(spend).toEqual(expect.objectContaining({ microUsd: 10_000, inputTokens: 1000, outputTokens: 500 }));

    // A second run by the same owner accumulates onto the same rollup row.
    const runId2 = await insertRunRow(sessionId, agentId, owner.id);
    await setBilledKind(runId2, "api_key");
    await recordRunUsage(runId2, "anthropic", "claude-sonnet-5", {
      usage: null,
      modelUsage: { "claude-sonnet-5": { inputTokens: 2000, outputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02 } },
      totalCostUsd: 0.02,
    }, env.DB);
    const accumulated = await spendRow(owner.id, "anthropic", "api_key");
    expect(accumulated?.microUsd).toBe(30_000);
    expect(accumulated?.inputTokens).toBe(3000);
  });

  // A run that goes on to fail still spent real tokens — the workflow calls
  // recordRunUsage before the ok/exitCode failure check
  // (worker/agent-run-workflow.ts), and this function itself has no
  // success/failure branching, so a "failed" status run must record and
  // roll up exactly like a "ready" one.
  it("records usage for a run regardless of its eventual status", async () => {
    const { sessionId, owner } = await room("failed-run");
    const agentId = await agent(sessionId, owner.id, "Builder", "anthropic");
    const runId = await insertRunRow(sessionId, agentId, owner.id);
    await setBilledKind(runId, "api_key");
    await env.DB.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").bind(runId).run();

    await recordRunUsage(runId, "anthropic", "claude-sonnet-5", {
      usage: null,
      modelUsage: { "claude-sonnet-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },
      totalCostUsd: 0.001,
    }, env.DB);

    const spend = await spendRow(owner.id, "anthropic", "api_key");
    expect(spend?.microUsd).toBe(1_000);
  });

  it("writes no rollup row when the model was unpriced (a null cost must not write a zero)", async () => {
    const { sessionId, owner } = await room("unpriced");
    const agentId = await agent(sessionId, owner.id, "Builder", "kimi");
    const runId = await insertRunRow(sessionId, agentId, owner.id, "kimi-unknown-model");
    await setBilledKind(runId, "api_key");

    await recordRunUsage(runId, "kimi", "kimi-unknown-model", {
      usage: null,
      modelUsage: { "kimi-unknown-model": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 5 } },
      totalCostUsd: 5,
    }, env.DB);

    const row = await agentRunRow(runId);
    expect(row?.costMicroUsd).toBeNull();
    expect(row?.costSource).toBe("estimated");
    expect(await spendRow(owner.id, "kimi", "api_key")).toBeNull();
  });

  it("never trusts the SDK's reported cost for a kimi run, even though it rides the same runner", async () => {
    const { sessionId, owner } = await room("kimi-estimate");
    const agentId = await agent(sessionId, owner.id, "Builder", "kimi");
    const runId = await insertRunRow(sessionId, agentId, owner.id, "kimi-k3");
    await setBilledKind(runId, "api_key");

    await recordRunUsage(runId, "kimi", "kimi-k3", {
      usage: null,
      modelUsage: { "kimi-k3": { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 999 } },
      totalCostUsd: 999,
    }, env.DB);

    const row = await agentRunRow(runId);
    expect(row?.costSource).toBe("estimated");
    expect(row?.costMicroUsd).not.toBe(999_000_000);
  });
});

describe("checkProviderBudget", () => {
  it("allows a run when the owner has no limit set", async () => {
    const { owner } = await room("no-limit");
    expect(await checkProviderBudget(owner.id, "anthropic", null, env.DB)).toEqual({ ok: true });
  });

  it("refuses a run at or over the monthly cap, allows one under it", async () => {
    const { owner } = await room("capped");
    await env.DB.prepare(
      `INSERT INTO user_provider_credentials (user_id, provider, kind, ciphertext, fingerprint, monthly_limit_micro_usd, created_at, updated_at)
       VALUES (?, 'anthropic', 'api_key', 'cipher', 'test', 100000, ?, ?)`,
    ).bind(owner.id, Date.now(), Date.now()).run();
    const month = new Date().toISOString().slice(0, 7);

    await env.DB.prepare(
      `INSERT INTO provider_spend_months (user_id, provider, kind, month, micro_usd, input_tokens, output_tokens) VALUES (?, 'anthropic', 'api_key', ?, 79000, 0, 0)`,
    ).bind(owner.id, month).run();
    expect(await checkProviderBudget(owner.id, "anthropic", null, env.DB)).toEqual({ ok: true });

    await env.DB.prepare(
      "UPDATE provider_spend_months SET micro_usd = 100000 WHERE user_id = ? AND provider = 'anthropic' AND kind = 'api_key' AND month = ?",
    ).bind(owner.id, month).run();
    const blocked = await checkProviderBudget(owner.id, "anthropic", null, env.DB);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.message).toContain("budget");
  });

  it("never limits a server-fallback run: no owner credential row means nothing to check", async () => {
    const { owner } = await room("server-fallback");
    // The owner has no anthropic credential row at all.
    expect(await checkProviderBudget(owner.id, "anthropic", null, env.DB)).toEqual({ ok: true });
  });
});

describe("getQueueItemAgentBudgetContext", () => {
  it("resolves the queue item's agent owner, provider, and named credential kind", async () => {
    const { sessionId, owner } = await room("queue-context");
    const input = parseAgentInput({ name: "Builder", role: "Engineer", task: "Work", ownerUserId: owner.id, provider: "anthropic", credentialKind: "oauth" });
    if (!input) throw new Error("Invalid test agent");
    const floor = await createFloorAgent(sessionId, owner.id, input, env.DB);
    const createdAgent = floor?.agents.find((candidate) => candidate.name === "Builder");
    if (!createdAgent) throw new Error("Agent was not created");
    const queueItemId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'queued', ?, ?)`,
    ).bind(queueItemId, sessionId, createdAgent.id, now, now).run();

    const context = await getQueueItemAgentBudgetContext(sessionId, queueItemId, env.DB);
    expect(context).toEqual({ ownerUserId: owner.id, provider: "anthropic", credentialKind: "oauth" });
  });
});

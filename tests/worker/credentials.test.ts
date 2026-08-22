import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as postAnthropicGateway } from "@/app/runtime/anthropic/[...path]/route";
import { POST as postOpenAiGateway } from "@/app/runtime/openai/[...path]/route";
import { createFloorAgent } from "@/db/floor";
import {
  deleteProviderCredential,
  getRunAgentOwnerCredential,
  listProviderCredentials,
  upsertProviderCredential,
} from "@/db/provider-credentials";
import { acceptInvite, createSession, deleteAccount, removeMember, upsertUser } from "@/db/sessions";
import { encryptCredential } from "@/lib/credential-crypto";
import { signRunGatewayToken } from "@/lib/runtime-token";
import { parseAgentInput } from "@/lib/validation";

const GATEWAY_SECRET = "worker-test-runtime-gateway-secret";
const ENCRYPTION_SECRET = "worker-test-credential-encryption-key";

function identity(id: string, name: string) {
  return { providerUserId: `credentials-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

async function room(suffix: string) {
  const owner = await upsertUser(identity(`${suffix}-owner`, "Owner Example"), env.DB);
  const member = await upsertUser(identity(`${suffix}-member`, "Member Example"), env.DB);
  const created = await createSession(owner.id, { title: `Credentials ${suffix}`, objective: null }, env.DB);
  await acceptInvite(created.inviteId, member.id, env.DB);
  return { sessionId: created.session.id, owner, member };
}

async function connectKey(userId: string, provider: "anthropic" | "openai", apiKey: string) {
  const ciphertext = await encryptCredential(apiKey, ENCRYPTION_SECRET, `${userId}:${provider}`);
  return upsertProviderCredential(userId, provider, {
    kind: "api_key",
    ciphertext,
    fingerprint: apiKey.slice(-4),
    validatedAt: Date.now(),
  }, env.DB);
}

const connectOpenAiKey = (userId: string, apiKey: string) => connectKey(userId, "openai", apiKey);

/** Run row plus the connection/candidate scaffolding getRunGatewayContext joins against. */
async function insertRunRow(sessionId: string, agentId: string, userId: string, status: string): Promise<string> {
  const now = Date.now();
  const connectionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repository_connections (id, session_id, installation_id, repository_id, repository_node_id, repository_owner, repository_name, repository_full_name, repository_private, default_branch, base_branch, status, connected_by, connected_at, updated_at)
     VALUES (?, ?, 'inst', 'repo', 'node', 'owner', 'name', 'owner/name', 1, 'main', 'main', 'ready', ?, ?, ?)`,
  ).bind(connectionId, sessionId, userId, now, now).run();
  const candidateId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repository_candidates (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'main', 'sha-base', 'active', ?, ?, ?)`,
  ).bind(candidateId, sessionId, connectionId, `candidate-${candidateId}`, userId, now, now).run();
  const queueItemId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO floor_queue_items (id, session_id, agent_id, position, status, created_at, updated_at)
     VALUES (?, ?, ?, 999, 'running', ?, ?)`,
  ).bind(queueItemId, sessionId, agentId, now, now).run();
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, attempt, status, model, sandbox_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sha-run', 1, ?, 'test-model', 'sandbox', ?, ?, ?)`,
  ).bind(runId, sessionId, queueItemId, agentId, candidateId, status, userId, now, now).run();
  return runId;
}

async function runningRun(suffix: string, agentOwner?: "member") {
  const { sessionId, owner, member } = await room(suffix);
  const agentOwnerId = agentOwner === "member" ? member.id : owner.id;
  const input = parseAgentInput({ name: "Builder", role: "Engineer", task: "Implement changes", ownerUserId: agentOwnerId });
  if (!input) throw new Error("Invalid test agent");
  const floor = await createFloorAgent(sessionId, owner.id, input, env.DB);
  const agent = floor?.agents.find((candidate) => candidate.name === "Builder");
  if (!agent) throw new Error("Agent was not created");
  const runId = await insertRunRow(sessionId, agent.id, owner.id, "running");
  return { sessionId, owner, member, runId };
}

function gatewayRequest(token: string) {
  return new Request("https://opnflr.com/app/runtime/openai/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "test", input: [] }),
  });
}

function gatewayParams(path: string[] = ["v1", "responses"]) {
  return { params: Promise.resolve({ path }) };
}

async function signedRunToken(runId: string, sessionId: string) {
  return signRunGatewayToken(
    { runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "openai" },
    GATEWAY_SECRET,
  );
}

describe("provider credential persistence", () => {
  it("stores, lists, and deletes write-only credential summaries", async () => {
    const user = await upsertUser(identity("store", "Store Example"), env.DB);
    const stored = await connectOpenAiKey(user.id, "sk-openai-test-abcd");
    expect(stored.provider).toBe("openai");
    expect(stored.kind).toBe("api_key");
    expect(stored.fingerprint).toBe("abcd");
    expect("ciphertext" in stored).toBe(false);

    const listed = await listProviderCredentials(user.id, env.DB);
    expect(listed).toHaveLength(1);
    expect(listed[0].fingerprint).toBe("abcd");

    const replaced = await connectOpenAiKey(user.id, "sk-openai-test-wxyz");
    expect(replaced.fingerprint).toBe("wxyz");
    expect(await listProviderCredentials(user.id, env.DB)).toHaveLength(1);

    expect(await deleteProviderCredential(user.id, "openai", env.DB)).toBe(true);
    expect(await deleteProviderCredential(user.id, "openai", env.DB)).toBe(false);
    expect(await listProviderCredentials(user.id, env.DB)).toHaveLength(0);
  });

  it("resolves only the agent owner's credential for a provider", async () => {
    const { sessionId, owner, member, runId } = await runningRun("resolve", "member");
    expect(await getRunAgentOwnerCredential(runId, "openai", env.DB)).toBeNull();
    // The session owner's credential must never be picked up — billing
    // follows whoever owns the agent, not who owns the session.
    await connectOpenAiKey(owner.id, "sk-openai-owner-key2");
    expect(await getRunAgentOwnerCredential(runId, "openai", env.DB)).toBeNull();
    await connectOpenAiKey(member.id, "sk-openai-member-key1");
    const resolved = await getRunAgentOwnerCredential(runId, "openai", env.DB);
    expect(resolved?.ownerUserId).toBe(member.id);
    expect(resolved?.ciphertext).toBeTruthy();
    // Provider is part of the key: no anthropic credential exists yet.
    expect(await getRunAgentOwnerCredential(runId, "anthropic", env.DB)).toBeNull();
    // Removing the member transfers their agents to the removing owner
    // (removeMember, PR #75) — billing follows the transfer, so the removed
    // member's key is never billed and the new owner's key resolves instead.
    const removal = await removeMember(sessionId, owner.id, member.id, env.DB);
    expect(typeof removal).toBe("object");
    const transferred = await getRunAgentOwnerCredential(runId, "openai", env.DB);
    expect(transferred?.ownerUserId).toBe(owner.id);
  });

  it("a cross-method re-key (account merge path) preserves the user id, so credentials stay decryptable", async () => {
    // upsertUser's byEmail fallback re-keys the SAME row to the new provider
    // sub — the user id never changes, so ciphertext bound to
    // `${userId}:${provider}` as AAD stays valid. A future migration that
    // collapses two rows into one would break that binding and must migrate
    // or drop the losing row's credentials — this test pins the invariant
    // the runtime path relies on.
    const first = await upsertUser(
      { providerUserId: "credentials-rekey-google", email: "rekey@example.com", displayName: "Rekey Example", fullName: "Rekey Example" },
      env.DB,
    );
    await connectOpenAiKey(first.id, "sk-openai-rekey-key9");
    const second = await upsertUser(
      { providerUserId: "credentials-rekey-otp", email: "rekey@example.com", displayName: "Rekey Example", fullName: "Rekey Example" },
      env.DB,
    );
    expect(second.id).toBe(first.id);
    const stored = await env.DB.prepare("SELECT ciphertext FROM user_provider_credentials WHERE user_id = ? AND provider = 'openai'")
      .bind(second.id)
      .first<{ ciphertext: string }>();
    expect(stored).not.toBeNull();
    const { decryptCredential } = await import("@/lib/credential-crypto");
    expect(await decryptCredential(stored!.ciphertext, ENCRYPTION_SECRET, `${second.id}:openai`)).toBe("sk-openai-rekey-key9");
  });

  it("deleteAccount removes the user's credentials", async () => {
    const user = await upsertUser(identity("delete", "Delete Example"), env.DB);
    await connectOpenAiKey(user.id, "sk-openai-test-gone");
    const result = await deleteAccount(user.id, env.DB);
    expect(result).toEqual({ deleted: true });
    const remaining = await env.DB.prepare("SELECT 1 AS present FROM user_provider_credentials WHERE user_id = ?")
      .bind(user.id)
      .first<{ present: number }>();
    expect(remaining).toBeNull();
  });
});

describe("OpenAI gateway credential resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (env as unknown as Record<string, unknown>).OPENAI_API_KEY;
  });

  function stubUpstream(capture: { authorization: string | null }) {
    vi.stubGlobal("fetch", async (_url: string, init: { headers: Headers }) => {
      capture.authorization = init.headers.get("authorization");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  it("uses the agent owner's connected key for the run", async () => {
    const { sessionId, owner, runId } = await runningRun("gw-owner");
    await connectOpenAiKey(owner.id, "sk-openai-owner-gwkey");
    const capture = { authorization: null as string | null };
    stubUpstream(capture);
    const response = await postOpenAiGateway(gatewayRequest(await signedRunToken(runId, sessionId)), gatewayParams());
    expect(response.status).toBe(200);
    expect(capture.authorization).toBe("Bearer sk-openai-owner-gwkey");
  });

  it("bills the member who owns the agent, not the session owner", async () => {
    const { sessionId, owner, member, runId } = await runningRun("gw-member-owned", "member");
    await connectOpenAiKey(owner.id, "sk-openai-session-owner");
    await connectOpenAiKey(member.id, "sk-openai-agent-owner");
    const capture = { authorization: null as string | null };
    stubUpstream(capture);
    const response = await postOpenAiGateway(gatewayRequest(await signedRunToken(runId, sessionId)), gatewayParams());
    expect(response.status).toBe(200);
    expect(capture.authorization).toBe("Bearer sk-openai-agent-owner");
  });

  it("uses the server key only when the owner has no credential", async () => {
    const { sessionId, runId } = await runningRun("gw-server");
    (env as unknown as Record<string, unknown>).OPENAI_API_KEY = "sk-openai-server-key";
    const capture = { authorization: null as string | null };
    stubUpstream(capture);
    const response = await postOpenAiGateway(gatewayRequest(await signedRunToken(runId, sessionId)), gatewayParams());
    expect(response.status).toBe(200);
    expect(capture.authorization).toBe("Bearer sk-openai-server-key");
  });

  it("refuses the run when neither an owner nor a server credential exists", async () => {
    const { sessionId, runId } = await runningRun("gw-none");
    const response = await postOpenAiGateway(gatewayRequest(await signedRunToken(runId, sessionId)), gatewayParams());
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("No OpenAI credential");
  });

  it("refuses rather than silently falling back when the owner credential cannot be read", async () => {
    const { sessionId, owner, runId } = await runningRun("gw-unreadable");
    // Ciphertext bound to the wrong context decrypts to null at the gateway.
    const wrongContext = await encryptCredential("sk-openai-owner-key3", ENCRYPTION_SECRET, "someone-else:openai");
    await upsertProviderCredential(owner.id, "openai", {
      kind: "api_key",
      ciphertext: wrongContext,
      fingerprint: "key3",
      validatedAt: Date.now(),
    }, env.DB);
    (env as unknown as Record<string, unknown>).OPENAI_API_KEY = "sk-openai-server-key";
    const response = await postOpenAiGateway(gatewayRequest(await signedRunToken(runId, sessionId)), gatewayParams());
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("could not be read");
  });

  it("anthropic gateway forwards allowed paths with the owner's key and x-api-key auth", async () => {
    const { sessionId, owner, runId } = await runningRun("anthro-owner");
    await connectKey(owner.id, "anthropic", "sk-ant-owner-gwkey");
    const captured: Array<{ url: string; apiKey: string | null; bearer: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Headers }) => {
      captured.push({ url, apiKey: init.headers.get("x-api-key"), bearer: init.headers.get("authorization") });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const token = await signRunGatewayToken(
      { runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "anthropic" },
      GATEWAY_SECRET,
    );
    function anthropicRequest(path: string) {
      return postAnthropicGateway(
        new Request(`https://opnflr.com/app/runtime/anthropic/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-opus-5" }),
        }),
        { params: Promise.resolve({ path: path.split("/") }) },
      );
    }
    expect((await anthropicRequest("v1/messages")).status).toBe(200);
    expect((await anthropicRequest("v1/messages/count_tokens")).status).toBe(200);
    expect(captured.map((call) => call.url)).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/messages/count_tokens",
    ]);
    // Upstream auth is x-api-key with the owner's key; the run JWT never leaves.
    expect(captured.every((call) => call.apiKey === "sk-ant-owner-gwkey" && call.bearer === null)).toBe(true);
    // Paths outside the allowlist are concealed even with a valid token.
    expect((await anthropicRequest("v1/models")).status).toBe(404);
  });

  it("anthropic gateway refuses without a resolvable credential and rejects wrong-operation tokens", async () => {
    const { sessionId, runId } = await runningRun("anthro-none");
    const token = await signRunGatewayToken(
      { runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "anthropic" },
      GATEWAY_SECRET,
    );
    const refused = await postAnthropicGateway(
      new Request("https://opnflr.com/app/runtime/anthropic/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["v1", "messages"] }) },
    );
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain("No Anthropic credential");

    const openaiOperation = await signRunGatewayToken(
      { runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "openai" },
      GATEWAY_SECRET,
    );
    const crossed = await postAnthropicGateway(
      new Request("https://opnflr.com/app/runtime/anthropic/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${openaiOperation}`, "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["v1", "messages"] }) },
    );
    expect(crossed.status).toBe(404);
  });

  it("keeps the existing rejection paths", async () => {
    const { sessionId, owner, runId } = await runningRun("gw-reject");
    await connectOpenAiKey(owner.id, "sk-openai-owner-key4");
    const noToken = await postOpenAiGateway(
      new Request("https://opnflr.com/app/runtime/openai/v1/responses", { method: "POST", body: "{}" }),
      gatewayParams(),
    );
    expect(noToken.status).toBe(404);
    const badToken = await postOpenAiGateway(gatewayRequest("not-a-jwt"), gatewayParams());
    expect(badToken.status).toBe(404);
    const wrongPath = await postOpenAiGateway(gatewayRequest(await signedRunToken(runId, sessionId)), gatewayParams(["v1", "models"]));
    expect(wrongPath.status).toBe(404);
    const wrongOperation = await postOpenAiGateway(
      gatewayRequest(await signRunGatewayToken(
        { runId, sessionId, repositoryId: "repo", candidateSha: "sha-run", operation: "events" },
        GATEWAY_SECRET,
      )),
      gatewayParams(),
    );
    expect(wrongOperation.status).toBe(404);
  });
});

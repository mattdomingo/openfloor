import { readFile, writeFile } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";

const promptPath = process.env.OPENFLOOR_PROMPT_PATH;
const resultPath = process.env.OPENFLOOR_RESULT_PATH;
const workspace = process.env.OPENFLOOR_WORKSPACE;
const gatewayUrl = process.env.OPENFLOOR_OPENAI_BASE_URL;
const gatewayToken = process.env.OPENFLOOR_OPENAI_TOKEN;
const model = process.env.OPENFLOOR_MODEL;
const eventsUrl = process.env.OPENFLOOR_EVENTS_URL;
const eventsToken = process.env.OPENFLOOR_EVENTS_TOKEN;
const contextUrl = process.env.OPENFLOOR_CONTEXT_URL;
const contextToken = process.env.OPENFLOOR_CONTEXT_TOKEN;
const mcpServerPath = process.env.OPENFLOOR_MCP_SERVER_PATH;
const conflictInputUrl = process.env.OPENFLOOR_CONFLICT_INPUT_URL;
const conflictInputToken = process.env.OPENFLOOR_CONFLICT_INPUT_TOKEN;
// Defense in depth only (worker/agent-run-workflow.ts never exports a bundle
// or publishes for a reply run, so nothing written here can escape the
// container regardless) — a reply run still gets Codex's own read-only
// sandbox so it cannot touch the workspace while answering.
const isReply = process.env.OPENFLOOR_RUN_MODE === "reply";

if (!promptPath || !resultPath || !workspace || !gatewayUrl || !gatewayToken || !model) {
  throw new Error("openfloor Codex runner configuration is incomplete");
}

const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

// Activity telemetry: best-effort only — a failure here must never fail the run.
const RUNNER_SEQUENCE_BASE = 1_000_000;
const MAX_DETAIL_CHARS = 2_000;
const FLUSH_SIZE = 10;
const FLUSH_INTERVAL_MS = 1_000;
const activity = {
  enabled: Boolean(eventsUrl && eventsToken),
  sequence: RUNNER_SEQUENCE_BASE,
  buffer: [],
  flushing: null,
  lastFlush: 0,
  timer: null,
};

function emitActivity(kind, detail) {
  if (!activity.enabled || !detail) return;
  activity.sequence += 1;
  activity.buffer.push({ sequence: activity.sequence, kind, detail: String(detail).slice(0, MAX_DETAIL_CHARS) });
  if (activity.buffer.length >= FLUSH_SIZE) void flushActivity();
  else if (!activity.timer) {
    const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - activity.lastFlush));
    activity.timer = setTimeout(() => { activity.timer = null; void flushActivity(); }, wait);
    activity.timer.unref?.();
  }
}

async function flushActivity() {
  if (!activity.enabled || activity.buffer.length === 0) return activity.flushing ?? undefined;
  if (activity.flushing) return activity.flushing;
  const events = activity.buffer.splice(0, FLUSH_SIZE);
  activity.flushing = (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(eventsUrl, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${eventsToken}` },
            body: JSON.stringify({ events }),
          });
          if (response.status === 404 || response.status === 413) {
            activity.enabled = false;
            return;
          }
          if (response.ok) {
            const result = await response.json().catch(() => null);
            if (result?.stop) activity.enabled = false;
            return;
          }
        } catch {
          // retry below
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
      activity.enabled = false;
    } finally {
      activity.lastFlush = Date.now();
      activity.flushing = null;
      if (activity.buffer.length > 0) void flushActivity();
    }
  })();
  return activity.flushing;
}

async function drainActivity() {
  while (activity.enabled && (activity.buffer.length > 0 || activity.flushing)) {
    await flushActivity();
    await activity.flushing;
  }
}

function firstLine(text) {
  const line = String(text ?? "").trim().split("\n").find((entry) => entry.trim());
  return line ? line.trim() : "";
}

function normalizeItem(item, phase) {
  if (!item || typeof item !== "object") return;
  if (item.type === "command_execution" && phase === "started") {
    emitActivity("command", `$ ${firstLine(item.command)}`);
  } else if (item.type === "command_execution" && phase === "completed") {
    emitActivity("command", `$ ${firstLine(item.command)} → exit ${item.exit_code ?? "?"}`);
  } else if (item.type === "reasoning" && phase === "completed") {
    emitActivity("reasoning", firstLine(item.text ?? item.summary));
  } else if (item.type === "file_change" && phase === "completed") {
    const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
    if (paths.length > 0) emitActivity("file_edit", `edited ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ""}`);
  } else if (item.type === "agent_message" && phase === "completed") {
    emitActivity("agent_message", item.text);
  } else if (item.type === "mcp_tool_call" && phase === "started") {
    emitActivity("tool_call", `called ${item.tool}`);
  } else if (item.type === "mcp_tool_call" && phase === "completed") {
    emitActivity("tool_call", item.status === "failed" ? `${item.tool} failed: ${firstLine(item.error?.message)}` : `${item.tool} completed`);
  } else if (item.type === "error") {
    emitActivity("error", firstLine(item.message));
  }
}

const prompt = await readFile(promptPath, "utf8");
// The MCP child is spawned by the Codex CLI itself, outside this process's
// network-disabled sandboxMode, so it's the one legitimate bridge back to
// live openfloor state. env is passed explicitly rather than relied on to
// inherit — the CLI's own MCP child-spawning behavior isn't something this
// SDK's TypeScript surface documents, so explicit is the reliable choice.
const mcpServers = contextUrl && contextToken && mcpServerPath ? {
  openfloor: {
    command: "node",
    args: [mcpServerPath],
    env: {
      OPENFLOOR_CONTEXT_URL: contextUrl,
      OPENFLOOR_CONTEXT_TOKEN: contextToken,
      ...(conflictInputUrl && conflictInputToken ? {
        OPENFLOOR_CONFLICT_INPUT_URL: conflictInputUrl,
        OPENFLOOR_CONFLICT_INPUT_TOKEN: conflictInputToken,
      } : {}),
    },
  },
} : undefined;
const codex = new Codex({ baseUrl: gatewayUrl, apiKey: gatewayToken, ...(mcpServers ? { config: { mcp_servers: mcpServers } } : {}) });
const threadOptions = {
  model,
  workingDirectory: workspace,
  sandboxMode: isReply ? "read-only" : "workspace-write",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
};
// Thread resume: worker/agent-run-workflow.ts restores the prior attempt's
// ~/.codex/sessions rollouts before this process starts and names the
// thread to continue. A missing rollout fails before the CLI emits any
// event ("no rollout found for thread id"), so that one case falls back to
// a fresh thread; a failure after events started flowing is a real failure.
const resumeThreadId = process.env.OPENFLOOR_RESUME_THREAD_ID || null;
let thread = resumeThreadId ? codex.resumeThread(resumeThreadId, threadOptions) : codex.startThread(threadOptions);
let resumed = Boolean(resumeThreadId);
let sawEvent = false;

let threadId = null;
let finalResponse = null;
let usage = null;
async function runTurn() {
  const streamed = await thread.runStreamed(prompt, { signal: controller.signal });
  for await (const event of streamed.events) {
    sawEvent = true;
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type === "turn.completed") usage = event.usage;
    if (event.type === "item.completed" && event.item.type === "agent_message") finalResponse = event.item.text;
    if (event.type === "item.started") normalizeItem(event.item, "started");
    if (event.type === "item.completed") normalizeItem(event.item, "completed");
    if (event.type === "turn.failed") emitActivity("error", firstLine(event.error?.message ?? "The agent turn failed."));
    const encoded = JSON.stringify(event);
    process.stdout.write(`${encoded.length > 20_000 ? `${encoded.slice(0, 20_000)}…` : encoded}\n`);
  }
}
try {
  try {
    await runTurn();
  } catch (error) {
    if (!resumed || sawEvent || controller.signal.aborted) throw error;
    emitActivity("error", `Could not resume thread ${resumeThreadId}; starting a fresh thread.`);
    resumed = false;
    threadId = null;
    thread = codex.startThread(threadOptions);
    await runTurn();
  }
  await drainActivity();
  await writeFile(resultPath, JSON.stringify({ ok: true, threadId: threadId ?? thread.id, resumed, finalResponse, usage }), "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emitActivity("error", firstLine(message));
  await drainActivity().catch(() => {});
  await writeFile(resultPath, JSON.stringify({ ok: false, threadId: threadId ?? thread.id, resumed, finalResponse, error: message }), "utf8");
  process.stderr.write(`${message}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
}

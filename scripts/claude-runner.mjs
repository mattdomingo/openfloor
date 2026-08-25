import { readFile, writeFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";

const promptPath = process.env.OPENFLOOR_PROMPT_PATH;
const resultPath = process.env.OPENFLOOR_RESULT_PATH;
const workspace = process.env.OPENFLOOR_WORKSPACE;
const gatewayUrl = process.env.OPENFLOOR_ANTHROPIC_BASE_URL;
const gatewayToken = process.env.OPENFLOOR_ANTHROPIC_TOKEN;
const model = process.env.OPENFLOOR_MODEL;
const eventsUrl = process.env.OPENFLOOR_EVENTS_URL;
const eventsToken = process.env.OPENFLOOR_EVENTS_TOKEN;
const contextUrl = process.env.OPENFLOOR_CONTEXT_URL;
const contextToken = process.env.OPENFLOOR_CONTEXT_TOKEN;
const mcpServerPath = process.env.OPENFLOOR_MCP_SERVER_PATH;
const conflictInputUrl = process.env.OPENFLOOR_CONFLICT_INPUT_URL;
const conflictInputToken = process.env.OPENFLOOR_CONFLICT_INPUT_TOKEN;
// Defense in depth only (worker/agent-run-workflow.ts never exports a bundle
// or publishes for a reply run) — a reply run also gets a narrower positive
// tool list with every file-modifying tool (Bash included — it can write
// files too) removed, same shape as the Codex runner's read-only sandbox.
const isReply = process.env.OPENFLOOR_RUN_MODE === "reply";

if (!promptPath || !resultPath || !workspace || !gatewayUrl || !gatewayToken || !model) {
  throw new Error("openfloor Claude runner configuration is incomplete");
}

// Activity telemetry: best-effort only — a failure here must never fail the
// run. Identical contract to codex-runner.mjs.
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

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Map SDK content blocks onto openfloor's existing agent_run_events kinds
// (command, reasoning, file_edit, agent_message, tool_call, error) — the same
// vocabulary normalizeItem() gives Codex events; no new kinds.
function normalizeAssistantBlock(block) {
  if (!block || typeof block !== "object") return;
  if (block.type === "text") {
    emitActivity("agent_message", firstLine(block.text));
  } else if (block.type === "thinking") {
    emitActivity("reasoning", firstLine(block.thinking));
  } else if (block.type === "tool_use") {
    if (block.name === "Bash") {
      emitActivity("command", `$ ${firstLine(block.input?.command)}`);
    } else if (FILE_EDIT_TOOLS.has(block.name)) {
      const path = block.input?.file_path ?? block.input?.notebook_path;
      if (path) emitActivity("file_edit", `edited ${path}`);
    } else if (typeof block.name === "string" && block.name.startsWith("mcp__")) {
      emitActivity("tool_call", `called ${block.name}`);
    }
  }
}

// Imported session skills, materialized by the workflow into this user's
// ~/.claude/skills/. Verified SDK behavior: `skills` must ALWAYS be passed —
// omitted means "CLI defaults", not "off" — and the Skill tool only exists
// when it is in the positive `tools` base set.
let skillNames = [];
try {
  const parsed = JSON.parse(process.env.OPENFLOOR_SKILLS ?? "[]");
  if (Array.isArray(parsed)) skillNames = parsed.filter((name) => typeof name === "string");
} catch {
  skillNames = [];
}

// Owner-configured remote MCP servers, serialized by the workflow into the
// SDK's mcpServers shape (headers already decrypted). "openfloor" is a
// reserved name — stripped defensively here even though the write path
// rejects it — because the openfloor session-context server below is always
// present and never user-replaceable.
let userMcpServers = {};
try {
  const parsed = JSON.parse(process.env.OPENFLOOR_MCP_SERVERS ?? "{}");
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    userMcpServers = Object.fromEntries(Object.entries(parsed).filter(([name]) => name !== "openfloor"));
  }
} catch {
  userMcpServers = {};
}
const userMcpServerNames = Object.keys(userMcpServers);

const prompt = await readFile(promptPath, "utf8");
// The MCP child is spawned by the CLI outside the Bash sandbox (same shape as
// the Codex runner's MCP bridge); its env is passed explicitly.
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
  ...userMcpServers,
} : (userMcpServerNames.length > 0 ? userMcpServers : undefined);

const response = query({
  prompt,
  options: {
    cwd: workspace,
    model,
    // Never blocks: "dontAsk" resolves every would-be permission prompt as a
    // clean denial instead of waiting on a human. Verified empirically
    // (AGENTS.md decision log): ask-default tools like WebFetch deny in this
    // mode, but Bash auto-approves rather than denying — so allowedTools is
    // an allow-list, not a restriction. The restriction mechanisms are the
    // positive `tools` base set (fails closed when an SDK upgrade adds new
    // built-ins) and `disallowedTools` (belt-and-braces for the two
    // network-capable tools that run in the CLI process OUTSIDE the Bash
    // sandbox proxy — the Codex runner's webSearchMode: "disabled" parity).
    // A skill's allowed-tools frontmatter cannot widen any of this.
    permissionMode: "dontAsk",
    tools: isReply
      ? ["Read", "Glob", "Grep", "TodoWrite", ...(skillNames.length > 0 ? ["Skill"] : [])]
      : ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "TodoWrite", ...(skillNames.length > 0 ? ["Skill"] : [])],
    allowedTools: [
      ...(isReply ? ["Read", "Glob", "Grep", "TodoWrite"] : ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "TodoWrite"]),
      ...(mcpServers ? ["mcp__openfloor__openfloor_session_context"] : []),
      ...(conflictInputUrl && conflictInputToken ? ["mcp__openfloor__openfloor_request_conflict_input"] : []),
      // Tools are enabled explicitly per configured server (the server-level
      // mcp__<name> spec) — never via a blanket permission mode. Which
      // servers exist at all is owner-configured; this makes their tools
      // usable in dontAsk mode, where per-tool defaults vary.
      ...userMcpServerNames.map((name) => `mcp__${name}`),
    ],
    disallowedTools: ["WebFetch", "WebSearch"],
    skills: skillNames,
    // "user" only: loads the sandbox posture (and later, imported skills)
    // from the container home directory, and keeps the target repository's
    // own .claude/settings.json, .mcp.json, and CLAUDE.md out of the session.
    settingSources: ["user"],
    ...(mcpServers ? { mcpServers } : {}),
    // Deliberately minimal CLI environment: the OPENFLOOR_* telemetry tokens
    // stay in this runner process and never enter the CLI or its subprocesses.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ANTHROPIC_BASE_URL: gatewayUrl,
      ANTHROPIC_AUTH_TOKEN: gatewayToken,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      // Strips ANTHROPIC_AUTH_TOKEN (the run-scoped gateway JWT) from every
      // subprocess the CLI spawns, so repository-controlled commands cannot
      // read it. The CLI's own model traffic keeps the token.
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    },
  },
});

let aborted = false;
function requestStop() {
  aborted = true;
  Promise.resolve(response.interrupt?.()).catch(() => {});
  setTimeout(() => process.exit(130), 10_000).unref?.();
}
process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);

let threadId = null;
let finalResponse = null;
let usage = null;
let resultError = null;
try {
  for await (const message of response) {
    if (message.type === "system" && message.subtype === "init") threadId = message.session_id ?? threadId;
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) normalizeAssistantBlock(block);
    }
    if (message.type === "result") {
      usage = message.usage ?? usage;
      if (message.subtype === "success") {
        finalResponse = message.result ?? finalResponse;
      } else {
        resultError = message.subtype;
        emitActivity("error", firstLine(`Claude run ended: ${message.subtype}`));
      }
    }
    const encoded = JSON.stringify(message);
    process.stdout.write(`${encoded.length > 20_000 ? `${encoded.slice(0, 20_000)}…` : encoded}\n`);
  }
  await drainActivity();
  if (resultError) {
    await writeFile(resultPath, JSON.stringify({ ok: false, threadId, finalResponse, usage, error: `Claude run ended: ${resultError}` }), "utf8");
    process.exitCode = aborted ? 130 : 1;
  } else {
    await writeFile(resultPath, JSON.stringify({ ok: true, threadId, finalResponse, usage }), "utf8");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emitActivity("error", firstLine(message));
  await drainActivity().catch(() => {});
  await writeFile(resultPath, JSON.stringify({ ok: false, threadId, finalResponse, usage, error: message }), "utf8");
  process.stderr.write(`${message}\n`);
  process.exitCode = aborted ? 130 : 1;
}

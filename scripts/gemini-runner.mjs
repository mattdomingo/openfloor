import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

// Thread resume (OPENFLOOR_RESUME_THREAD_ID, see the Codex/Claude runners) is
// deliberately not wired here: the pinned gemini-cli's resume support is
// unverified, so worker/agent-run-workflow.ts never passes the variable to
// this runner and never persists a Gemini session store.

const promptPath = process.env.OPENFLOOR_PROMPT_PATH;
const resultPath = process.env.OPENFLOOR_RESULT_PATH;
const workspace = process.env.OPENFLOOR_WORKSPACE;
const gatewayUrl = process.env.OPENFLOOR_GEMINI_BASE_URL;
const gatewayToken = process.env.OPENFLOOR_GEMINI_TOKEN;
const model = process.env.OPENFLOOR_MODEL;
const eventsUrl = process.env.OPENFLOOR_EVENTS_URL;
const eventsToken = process.env.OPENFLOOR_EVENTS_TOKEN;
const systemSettingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;

if (!promptPath || !resultPath || !workspace || !gatewayUrl || !gatewayToken || !model) {
  throw new Error("openfloor Gemini runner configuration is incomplete");
}

// Activity telemetry: best-effort only — a failure here must never fail the
// run. Identical contract to codex-runner.mjs (deliberately copied, like the
// Claude runner's copy: three small duplicates beat a shared module the
// Dockerfile would have to COPY and version separately).
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

// Built-in tool names as they appear in stream-json `tool_use` events
// (verified against the pinned CLI, Spike C). Anything else — MCP tools
// included — is surfaced as a generic tool_call, the codex-runner convention.
const FILE_EDIT_TOOLS = new Set(["write_file", "replace", "edit"]);
const SILENT_TOOLS = new Set(["read_file", "read_many_files", "list_directory", "glob", "search_file_content", "grep", "write_todos"]);

const prompt = await readFile(promptPath, "utf8");

// The CLI reads its posture from the SYSTEM-scope settings file the workflow
// wrote (auth pinning, folder trust off, tool excludes, the openfloor MCP
// bridge, telemetry/update kill switches) — see lib/gemini-settings.ts.
// GEMINI_API_KEY is a placeholder; the local broker supplies the real token
// outside the namespace containing this CLI and all of its tools.
const child = spawn(
  "/opt/openfloor/node_modules/.bin/gemini",
  ["-p", prompt, "--output-format", "stream-json", "--approval-mode", "yolo", "-m", model],
  {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GEMINI_API_KEY: gatewayToken,
      GOOGLE_GEMINI_BASE_URL: gatewayUrl,
      ...(systemSettingsPath ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath } : {}),
      // Provider-level proxy wiring, if the container runtime supplies it.
      ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
      ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
      ...(process.env.no_proxy ? { no_proxy: process.env.no_proxy } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let aborted = false;
process.on("SIGTERM", () => { aborted = true; child.kill("SIGTERM"); });
process.on("SIGINT", () => { aborted = true; child.kill("SIGINT"); });

let threadId = null;
let finalResponse = null;
let usage = null;
let resultError = null;
// Assistant text arrives as many `delta` message events; buffer the turn and
// emit one agent_message when a non-delta event ends it.
let assistantBuffer = "";
function flushAssistant() {
  if (!assistantBuffer.trim()) { assistantBuffer = ""; return; }
  emitActivity("agent_message", firstLine(assistantBuffer));
  finalResponse = assistantBuffer.trim();
  assistantBuffer = "";
}

function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "init") {
    threadId = event.session_id ?? threadId;
  } else if (event.type === "message" && event.role === "assistant") {
    assistantBuffer += String(event.content ?? "");
    return;
  } else if (event.type === "tool_use") {
    flushAssistant();
    const name = String(event.tool_name ?? "");
    if (name === "run_shell_command") {
      emitActivity("command", `$ ${firstLine(event.parameters?.command)}`);
    } else if (FILE_EDIT_TOOLS.has(name)) {
      const path = event.parameters?.file_path ?? event.parameters?.path;
      if (path) emitActivity("file_edit", `edited ${path}`);
    } else if (name && !SILENT_TOOLS.has(name)) {
      emitActivity("tool_call", `called ${name}`);
    }
  } else if (event.type === "error") {
    emitActivity("error", firstLine(event.message ?? event.error?.message));
  } else if (event.type === "result") {
    flushAssistant();
    usage = event.stats ?? usage;
    if (event.status !== "success") {
      resultError = firstLine(event.error?.message ?? `Gemini run ended: ${event.status}`);
      emitActivity("error", resultError);
    }
  }
}

const stderrChunks = [];
child.stderr.on("data", (chunk) => {
  stderrChunks.push(chunk);
  process.stderr.write(chunk);
});

const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event = null;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // Non-JSON CLI chatter: keep it in the raw log only.
  }
  if (event) handleEvent(event);
  process.stdout.write(`${trimmed.length > 20_000 ? `${trimmed.slice(0, 20_000)}…` : trimmed}\n`);
});

const exitCode = await new Promise((resolve) => {
  child.on("close", (code, signal) => resolve(signal ? 130 : code ?? 1));
});
flushAssistant();
await drainActivity().catch(() => {});
if (aborted || exitCode === 130) {
  await writeFile(resultPath, JSON.stringify({ ok: false, threadId, finalResponse, usage, error: "Gemini run cancelled." }), "utf8");
  process.exitCode = 130;
} else if (resultError || exitCode !== 0) {
  const message = resultError ?? firstLine(Buffer.concat(stderrChunks).toString("utf8")) ?? `The Gemini CLI exited with code ${exitCode}`;
  await writeFile(resultPath, JSON.stringify({ ok: false, threadId, finalResponse, usage, error: message }), "utf8");
  process.exitCode = 1;
} else {
  await writeFile(resultPath, JSON.stringify({ ok: true, threadId, finalResponse, usage }), "utf8");
}

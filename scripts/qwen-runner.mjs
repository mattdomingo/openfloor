import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

// The Qwen Code runner: serves both the qwen (Alibaba Cloud) and deepseek
// providers — the pinned CLI speaks OpenAI chat completions, and the only
// per-provider difference is which gateway OPENFLOOR_QWEN_BASE_URL names.
// Structurally the Gemini runner (same srt-wrapped, non-root posture), but
// the CLI's stream-json vocabulary is Claude-Code-shaped rather than
// gemini-cli's, so the normalizer below is its own (Spike Q1, 2026-08-28).
//
// Thread resume: worker/agent-run-workflow.ts restores the prior attempt's
// ~/.qwen/projects store into this run's HOME and passes the session id in
// OPENFLOOR_RESUME_THREAD_ID; the CLI continues it with --resume <id> (Spike
// Q1 step 4: same session_id, prior turns replayed in the next request).

const promptPath = process.env.OPENFLOOR_PROMPT_PATH;
const resultPath = process.env.OPENFLOOR_RESULT_PATH;
const workspace = process.env.OPENFLOOR_WORKSPACE;
const gatewayUrl = process.env.OPENFLOOR_QWEN_BASE_URL;
const gatewayToken = process.env.OPENFLOOR_QWEN_TOKEN;
const model = process.env.OPENFLOOR_MODEL;
const eventsUrl = process.env.OPENFLOOR_EVENTS_URL;
const eventsToken = process.env.OPENFLOOR_EVENTS_TOKEN;
const systemSettingsPath = process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
const resumeThreadId = process.env.OPENFLOOR_RESUME_THREAD_ID || null;
// ponytail: overridable only so the runner can be exercised keyless against
// a stub outside the image; the workflow never sets it.
const qwenBin = process.env.OPENFLOOR_QWEN_BIN || "/opt/openfloor/node_modules/.bin/qwen";

if (!promptPath || !resultPath || !workspace || !gatewayUrl || !gatewayToken || !model) {
  throw new Error("openfloor Qwen runner configuration is incomplete");
}

// Activity telemetry: best-effort only — a failure here must never fail the
// run. Identical contract to codex-runner.mjs (deliberately copied, like the
// Claude and Gemini runners' copies: small duplicates beat a shared module
// the Dockerfile would have to COPY and version separately).
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

// Built-in tool names as they appear in stream-json `tool_use` blocks
// (verified against the pinned CLI, Spike Q1). Anything else — MCP tools
// included — is surfaced as a generic tool_call, the codex-runner convention.
const FILE_EDIT_TOOLS = new Set(["write_file", "edit", "notebook_edit"]);
const SILENT_TOOLS = new Set(["read_file", "read_many_files", "list_directory", "glob", "grep_search", "todo_write", "tool_search", "read_mcp_resource"]);
// The CLI reports an upstream API error as assistant TEXT and a `result` with
// subtype "success" / is_error false / exit 0 (Spike Q1, verified on a 401),
// so the runner has to recognize the text itself.
const API_ERROR_PATTERN = /^\[API Error:/;

const prompt = await readFile(promptPath, "utf8");

// The CLI reads its posture from the SYSTEM-scope settings file the workflow
// wrote (auth pinning, folder trust off, tool denies, the openfloor MCP
// bridge, telemetry/usage-stats/memory kill switches) — see
// lib/qwen-settings.ts. OPENAI_API_KEY carries the run-scoped gateway JWT;
// OPENAI_BASE_URL points model traffic at the openfloor gateway. The child-
// process preload routes model-selected commands across the workspace uid/srt
// boundary.
function spawnCli(resumeId) {
  return spawn(
    qwenBin,
    ["-p", prompt, "--output-format", "stream-json", "--approval-mode", "yolo", "-m", model, ...(resumeId ? ["--resume", resumeId] : [])],
    {
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_OPTIONS: "--import file:///opt/openfloor/runner-env-preload.mjs",
        OPENAI_API_KEY: gatewayToken,
        OPENAI_BASE_URL: gatewayUrl,
        QWEN_CODE_SUPPRESS_YOLO_WARNING: "1",
        ...(systemSettingsPath ? { QWEN_CODE_SYSTEM_SETTINGS_PATH: systemSettingsPath } : {}),
        // Provider-level proxy wiring, if the container runtime supplies it.
        ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
        ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
        ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
        ...(process.env.no_proxy ? { no_proxy: process.env.no_proxy } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

let child = null;
let aborted = false;
process.on("SIGTERM", () => { aborted = true; child?.kill("SIGTERM"); });
process.on("SIGINT", () => { aborted = true; child?.kill("SIGINT"); });

let threadId = null;
let sawInit = false;
let finalResponse = null;
let usage = null;
let resultError = null;
let stderrChunks = [];

function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "system" && event.subtype === "init") {
    sawInit = true;
    threadId = event.session_id ?? threadId;
  } else if (event.type === "assistant") {
    // One event per model turn, content blocks complete (no deltas).
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && String(block.text ?? "").trim()) {
        finalResponse = String(block.text).trim();
        // An upstream API error arrives as assistant text; it is reported
        // once, as the error event at `result`, not as an agent message.
        if (!API_ERROR_PATTERN.test(finalResponse)) emitActivity("agent_message", firstLine(block.text));
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "");
        if (name === "run_shell_command") {
          emitActivity("command", `$ ${firstLine(block.input?.command)}`);
        } else if (FILE_EDIT_TOOLS.has(name)) {
          const path = block.input?.file_path ?? block.input?.path;
          if (path) emitActivity("file_edit", `edited ${path}`);
        } else if (name && !SILENT_TOOLS.has(name)) {
          emitActivity("tool_call", `called ${name}`);
        }
      }
    }
  } else if (event.type === "result") {
    usage = event.usage ?? usage;
    if (typeof event.result === "string" && event.result.trim()) finalResponse = event.result.trim();
    if (event.is_error || (event.subtype && event.subtype !== "success")) {
      resultError = firstLine(event.result ?? event.error ?? `Qwen Code run ended: ${event.subtype}`);
      emitActivity("error", resultError);
    } else if (finalResponse && API_ERROR_PATTERN.test(finalResponse)) {
      resultError = firstLine(finalResponse);
      emitActivity("error", resultError);
    }
  }
}

async function runCli(resumeId) {
  child = spawnCli(resumeId);
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
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve(signal ? 130 : code ?? 1));
  });
}

let resumed = Boolean(resumeThreadId);
let exitCode = await runCli(resumeThreadId);
// A resume whose session file is missing exits 1 before the init event
// (`No saved session found with title "<id>".`, Spike Q1) and makes no model
// call — the Claude/Codex runners' fall-back-to-fresh contract applies:
// report it and start a fresh thread rather than fail the run.
if (resumed && !sawInit && !aborted && exitCode !== 0) {
  emitActivity("error", `Could not resume session ${resumeThreadId} (${firstLine(Buffer.concat(stderrChunks).toString("utf8")) || `exit ${exitCode}`}); starting a fresh thread.`);
  resumed = false;
  stderrChunks = [];
  threadId = null;
  finalResponse = null;
  usage = null;
  resultError = null;
  exitCode = await runCli(null);
}
resumed = resumed && sawInit && threadId === resumeThreadId;
await drainActivity().catch(() => {});
if (aborted || exitCode === 130) {
  await writeFile(resultPath, JSON.stringify({ ok: false, threadId, resumed, finalResponse, usage, error: "Qwen Code run cancelled." }), "utf8");
  process.exitCode = 130;
} else if (resultError || exitCode !== 0) {
  const message = resultError ?? firstLine(Buffer.concat(stderrChunks).toString("utf8")) ?? `The Qwen Code CLI exited with code ${exitCode}`;
  await writeFile(resultPath, JSON.stringify({ ok: false, threadId, resumed, finalResponse, usage, error: message }), "utf8");
  process.exitCode = 1;
} else {
  await writeFile(resultPath, JSON.stringify({ ok: true, threadId, resumed, finalResponse, usage }), "utf8");
}

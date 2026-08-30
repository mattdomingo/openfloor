// Loaded inside Gemini/Qwen CLI processes. Strip inherited gateway and
// openfloor bearer tokens from repository-controlled child commands. The
// built-in MCP bridge gets explicit credentials in its spawn env and is
// allowed through so live session context keeps working.
import { createRequire } from "node:module";

const { spawn, spawnSync, exec, execFile, execFileSync } = createRequire(import.meta.url)("node:child_process");
const childProcess = createRequire(import.meta.url)("node:child_process");
const sensitive = /^(?:OPENFLOOR_.*(?:TOKEN|SECRET|KEY)|(?:GEMINI_API_KEY|OPENAI_API_KEY|OPENAI_BASE_URL|GOOGLE_GEMINI_BASE_URL))$/;
const mcpTokens = new Set(["OPENFLOOR_CONTEXT_TOKEN", "OPENFLOOR_CONFLICT_INPUT_TOKEN"]);

function isBuiltinMcp(command, args) {
  return (command === "node" || command === process.execPath)
    && Array.isArray(args)
    && args[0] === "/opt/openfloor/openfloor-mcp.mjs";
}

function scrub(command, args, options) {
  const next = { ...(options ?? {}) };
  const source = next.env ?? process.env;
  const builtInMcp = isBuiltinMcp(command, args);
  next.env = Object.fromEntries(Object.entries(source).filter(([name]) => !sensitive.test(name) || (builtInMcp && mcpTokens.has(name))));
  return next;
}

childProcess.spawn = (command, args, options) => spawn(command, args, scrub(command, args, options));
childProcess.spawnSync = (command, args, options) => spawnSync(command, args, scrub(command, args, options));
childProcess.exec = (command, options, callback) => typeof options === "function"
  ? exec(command, scrub(command, [], undefined), options)
  : exec(command, scrub(command, [], options), callback);
childProcess.execFile = (command, args, options, callback) => {
  if (typeof args === "function") return execFile(command, [], scrub(command, [], undefined), args);
  if (!Array.isArray(args)) {
    const actualCallback = typeof options === "function" ? options : callback;
    return execFile(command, [], scrub(command, [], args), actualCallback);
  }
  if (typeof options === "function") return execFile(command, args, scrub(command, args, undefined), options);
  return execFile(command, args, scrub(command, args, options), callback);
};
childProcess.execFileSync = (command, args, options) => Array.isArray(args)
  ? execFileSync(command, args, scrub(command, args, options))
  : execFileSync(command, [], scrub(command, [], args));

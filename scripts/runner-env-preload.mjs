// Loaded inside Gemini/Qwen CLI processes. Strip inherited gateway and
// openfloor bearer tokens from repository-controlled child commands. The
// built-in MCP bridge gets explicit credentials in its spawn env and is
// allowed through so live session context keeps working.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const original = {
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
  exec: childProcess.exec,
  execSync: childProcess.execSync,
  execFile: childProcess.execFile,
  execFileSync: childProcess.execFileSync,
  fork: childProcess.fork,
};
const safeNames = new Set([
  "CI", "COLORTERM", "FORCE_COLOR", "HOME", "LANG", "LANGUAGE", "LOGNAME",
  "NO_COLOR", "OLDPWD", "PATH", "PWD", "SHELL", "TEMP", "TERM", "TMP",
  "TMPDIR", "TZ", "USER", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR", "XDG_STATE_HOME",
]);
const builtInMcpNames = new Set([
  "OPENFLOOR_CONTEXT_URL",
  "OPENFLOOR_CONTEXT_TOKEN",
  "OPENFLOOR_CONFLICT_INPUT_URL",
  "OPENFLOOR_CONFLICT_INPUT_TOKEN",
]);

function isBuiltinMcp(command, args) {
  return (command === "node" || command === process.execPath)
    && Array.isArray(args)
    && args[0] === "/opt/openfloor/openfloor-mcp.mjs";
}

function scrub(command, args, options) {
  const next = { ...(options ?? {}) };
  const source = next.env ?? process.env;
  const builtInMcp = isBuiltinMcp(command, args);
  next.env = Object.fromEntries(Object.entries(source).filter(([name]) => (
    safeNames.has(name)
    || name.startsWith("LC_")
    || (builtInMcp && builtInMcpNames.has(name))
  )));
  return next;
}

function normalized(args, options) {
  return Array.isArray(args) ? { args, options } : { args: [], options: args };
}

childProcess.spawn = (command, args, options) => {
  const call = normalized(args, options);
  return original.spawn(command, call.args, scrub(command, call.args, call.options));
};
childProcess.spawnSync = (command, args, options) => {
  const call = normalized(args, options);
  return original.spawnSync(command, call.args, scrub(command, call.args, call.options));
};
childProcess.exec = (command, options, callback) => typeof options === "function"
  ? original.exec(command, scrub(command, [], undefined), options)
  : original.exec(command, scrub(command, [], options), callback);
childProcess.execSync = (command, options) => original.execSync(command, scrub(command, [], options));
childProcess.execFile = (command, args, options, callback) => {
  if (typeof args === "function") return original.execFile(command, [], scrub(command, [], undefined), args);
  if (!Array.isArray(args)) {
    const actualCallback = typeof options === "function" ? options : callback;
    return original.execFile(command, [], scrub(command, [], args), actualCallback);
  }
  if (typeof options === "function") return original.execFile(command, args, scrub(command, args, undefined), options);
  return original.execFile(command, args, scrub(command, args, options), callback);
};
childProcess.execFileSync = (command, args, options) => Array.isArray(args)
  ? original.execFileSync(command, args, scrub(command, args, options))
  : original.execFileSync(command, [], scrub(command, [], args));
childProcess.fork = (modulePath, args, options) => {
  const call = normalized(args, options);
  return original.fork(modulePath, call.args, scrub(process.execPath, [modulePath, ...call.args], call.options));
};

// NODE_OPTIONS preloads run before the CLI entrypoint. Sync the patched CommonJS
// object into `node:child_process` named exports before the CLI imports them.
syncBuiltinESMExports();

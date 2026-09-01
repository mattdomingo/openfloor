// Loaded inside Gemini/Qwen CLI processes. Every repository-controlled child
// crosses the setuid runtime launcher, which clears credentials, changes to
// openfloor-workspace, and applies the root-owned srt policy. The built-in MCP
// bridge is trusted provider code: it stays under openfloor-provider and gets
// only its explicit context/conflict credentials.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const workspaceExec = process.env.NODE_ENV === "test" && process.env.OPENFLOOR_WORKSPACE_EXEC_TEST_ONLY
  ? process.env.OPENFLOOR_WORKSPACE_EXEC_TEST_ONLY
  : "/opt/openfloor/openfloor-workspace-exec";
delete process.env.OPENFLOOR_WORKSPACE_EXEC_TEST_ONLY;
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

function workspace(command, args, options) {
  const next = scrub(command, args, options);
  if (next.shell) {
    const shell = typeof next.shell === "string" ? next.shell : "/bin/sh";
    delete next.shell;
    return { command: workspaceExec, args: [shell, "-c", [command, ...args].join(" ")], options: next };
  }
  return {
    command: workspaceExec,
    args: [command, ...args],
    options: next,
  };
}

function normalized(args, options) {
  return Array.isArray(args) ? { args, options } : { args: [], options: args };
}

childProcess.spawn = (command, args, options) => {
  const call = normalized(args, options);
  if (isBuiltinMcp(command, call.args)) return original.spawn(command, call.args, scrub(command, call.args, call.options));
  const next = workspace(command, call.args, call.options);
  return original.spawn(next.command, next.args, next.options);
};
childProcess.spawnSync = (command, args, options) => {
  const call = normalized(args, options);
  if (isBuiltinMcp(command, call.args)) return original.spawnSync(command, call.args, scrub(command, call.args, call.options));
  const next = workspace(command, call.args, call.options);
  return original.spawnSync(next.command, next.args, next.options);
};
childProcess.exec = (command, options, callback) => {
  const actualOptions = typeof options === "function" ? undefined : options;
  const actualCallback = typeof options === "function" ? options : callback;
  const next = scrub(command, [], actualOptions);
  const shell = typeof next.shell === "string" ? next.shell : "/bin/sh";
  delete next.shell;
  return original.execFile(workspaceExec, [shell, "-c", command], next, actualCallback);
};
childProcess.execSync = (command, options) => {
  const next = scrub(command, [], options);
  const shell = typeof next.shell === "string" ? next.shell : "/bin/sh";
  delete next.shell;
  return original.execFileSync(workspaceExec, [shell, "-c", command], next);
};
childProcess.execFile = (command, args, options, callback) => {
  if (typeof args === "function") {
    const next = workspace(command, [], undefined);
    return original.execFile(next.command, next.args, next.options, args);
  }
  if (!Array.isArray(args)) {
    const actualCallback = typeof options === "function" ? options : callback;
    const next = workspace(command, [], args);
    return original.execFile(next.command, next.args, next.options, actualCallback);
  }
  if (isBuiltinMcp(command, args)) {
    if (typeof options === "function") return original.execFile(command, args, scrub(command, args, undefined), options);
    return original.execFile(command, args, scrub(command, args, options), callback);
  }
  const next = workspace(command, args, typeof options === "function" ? undefined : options);
  return original.execFile(next.command, next.args, next.options, typeof options === "function" ? options : callback);
};
childProcess.execFileSync = (command, args, options) => {
  const call = Array.isArray(args) ? { args, options } : { args: [], options: args };
  if (isBuiltinMcp(command, call.args)) return original.execFileSync(command, call.args, scrub(command, call.args, call.options));
  const next = workspace(command, call.args, call.options);
  return original.execFileSync(next.command, next.args, next.options);
};
childProcess.fork = (modulePath, args, options) => {
  const call = normalized(args, options);
  const next = scrub(process.execPath, [modulePath, ...call.args], call.options);
  const execPath = next.execPath ?? process.execPath;
  let execArgv = next.execArgv ?? process.execArgv;
  if (next.execArgv === undefined && process._eval != null) {
    const index = execArgv.lastIndexOf(process._eval);
    if (index > 0) execArgv = [...execArgv.slice(0, index - 1), ...execArgv.slice(index + 1)];
  }
  delete next.execPath;
  delete next.execArgv;
  if (!next.stdio) next.stdio = next.silent
    ? ["pipe", "pipe", "pipe", "ipc"]
    : ["inherit", "inherit", "inherit", "ipc"];
  delete next.silent;
  return original.spawn(workspaceExec, [execPath, ...execArgv, modulePath, ...call.args], next);
};

// NODE_OPTIONS preloads run before the CLI entrypoint. Sync the patched CommonJS
// object into `node:child_process` named exports before the CLI imports them.
syncBuiltinESMExports();

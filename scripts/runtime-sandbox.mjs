import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RUNTIME_FILES = ["codex-runner.mjs", "claude-runner.mjs", "gemini-runner.mjs", "qwen-runner.mjs", "gemini-proxy-preload.mjs", "openfloor-mcp.mjs", "runtime-bridge.mjs"];

/** @type {string[]} */
const SETPRIV = ["/usr/bin/setpriv", "--reuid=10002", "--regid=10001", "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--"];

/**
 * Mount only execution dependencies. The broker, publisher, credentials,
 * container service and host process tree are outside this namespace.
 * @param {string[]} command
 * @param {Record<string, string>} [environment]
 * @param {{
 *   brokerPath?: string,
 *   readOnly?: boolean,
 *   loopback?: boolean,
 *   extraRoFiles?: string[],
 *   extraBinds?: string[],
 * }} [options]
 */
export function sandboxArguments(command, environment = {}, {
  brokerPath, readOnly = false, loopback = false, extraRoFiles = [], extraBinds = [],
} = {}) {
  const args = ["--die-with-parent", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--new-session", "--clearenv"];
  for (const path of ["/usr", "/bin", "/lib", "/lib64"]) if (existsSync(path)) args.push("--ro-bind", path, path);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run", "--dir", "/etc", "--dir", "/opt/openfloor", "--dir", "/workspace");
  for (const path of ["/etc/ssl", "/etc/ld.so.cache", "/etc/passwd", "/etc/group"]) if (existsSync(path)) args.push("--ro-bind", path, path);
  args.push("--ro-bind", "/opt/openfloor/node_modules", "/opt/openfloor/node_modules");
  for (const file of [...RUNTIME_FILES, ...extraRoFiles]) args.push("--ro-bind", `/opt/openfloor/${file}`, `/opt/openfloor/${file}`);
  args.push(readOnly ? "--ro-bind" : "--bind", "/workspace/repository", "/workspace/repository");
  args.push("--bind", "/tmp/openfloor", "/tmp/openfloor");
  for (const path of extraBinds) args.push("--bind", path, path);
  if (existsSync("/workspace/attachments")) args.push("--ro-bind", "/workspace/attachments", "/workspace/attachments");
  if (brokerPath) args.push("--ro-bind", brokerPath, "/run/openfloor-broker.sock");
  const clean = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/openfloor/provider-home", LANG: "C.UTF-8", ...environment };
  for (const [name, value] of Object.entries(clean)) args.push("--setenv", name, String(value));
  // bwrap starts as root only to create mounts/namespaces. setpriv permanently
  // drops setup capabilities and selects the workspace identity before any
  // runner, native file tool, repository command, or restored state executes.
  // Preview runtime needs loopback inside the private netns; only that setup
  // shell receives CAP_NET_ADMIN, and setpriv clears it before the candidate.
  args.push("--chdir", "/workspace/repository", "--cap-add", "CAP_SETUID", "--cap-add", "CAP_SETGID", "--cap-add", "CAP_SETPCAP");
  if (loopback) args.push("--cap-add", "CAP_NET_ADMIN");
  args.push("--");
  if (loopback) {
    args.push("/bin/sh", "-c", "/usr/sbin/ip link set lo up && exec /usr/bin/setpriv --reuid=10002 --regid=10001 --clear-groups --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \"$@\"", "openfloor-loopback", ...command);
  } else {
    args.push(...SETPRIV, ...command);
  }
  return args;
}

export function startSandbox(command, environment, options) {
  const child = spawn("/usr/bin/bwrap", ["--as-pid-1", "--info-fd", "3", ...sandboxArguments(command, environment, options)], {
    env: { PATH: "/usr/bin:/bin" }, stdio: ["inherit", "inherit", "inherit", "pipe"],
  });
  // Signal the namespace's provider supervisor, not bwrap: terminating bwrap
  // immediately SIGKILLs the namespace before runners can flush transcripts.
  const terminateWrapper = child.kill.bind(child);
  let namespacePid;
  let pendingSignal;
  let exited = false;
  let shutdownTimer;
  let information = "";
  child.on("exit", () => { exited = true; clearTimeout(shutdownTimer); });
  child.stdio[3].on("data", (chunk) => {
    information += chunk.toString("utf8");
    if (information.length > 4096) { terminateWrapper("SIGKILL"); return; }
    try {
      const value = JSON.parse(information)["child-pid"];
      if (!Number.isSafeInteger(value) || value <= 1) throw new Error("Invalid namespace pid");
      namespacePid = value;
      if (pendingSignal) child.kill(pendingSignal);
    } catch { /* The small JSON document can arrive in multiple chunks. */ }
  });
  child.kill = (signal = "SIGTERM") => {
    if (exited) return false;
    if (signal === "SIGKILL") return terminateWrapper(signal);
    if (!shutdownTimer) shutdownTimer = setTimeout(() => { if (!exited) terminateWrapper("SIGKILL"); }, 10_000).unref();
    if (!namespacePid) { pendingSignal = signal; return true; }
    try { process.kill(namespacePid, signal); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv.slice(2);
  if (command.length === 0) throw new Error("An isolated command is required");
  const environment = Object.fromEntries(["OPENFLOOR_RUN_BRANCH", "OPENFLOOR_RUN_SHORT"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  const child = startSandbox(command, environment);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => { process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}

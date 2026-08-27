import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import process from "node:process";
import { selectSingleHttpPort } from "./repository-preview.mjs";

const COMMANDS = {
  npm: (script) => ["npm", ["run", script]],
  pnpm: (script) => ["pnpm", ["run", script]],
  yarn: (script) => ["yarn", ["run", script]],
  bun: (script) => ["bun", ["run", script]],
};
const manager = process.argv[2];
const script = process.argv[3];
if (!(manager in COMMANDS) || !["dev", "start"].includes(script)) {
  throw new Error("Unsupported preview runtime selection.");
}

spawnSync("ip", ["link", "set", "lo", "up"], { stdio: "inherit" });
const [command, args] = COMMANDS[manager](script);
const app = spawn(command, args, { cwd: "/workspace/repository", stdio: "inherit", env: safeRuntimeEnvironment() });
app.once("exit", (code) => {
  process.stderr.write(`Preview app exited before relay was ready (${code ?? "signal"}).\n`);
  process.exit(code ?? 1);
});

const port = await discoverSingleHttpPort(app);
const relay = spawn("socat", [
  "UNIX-LISTEN:/workspace/preview.sock,fork,unlink-early,mode=0666",
  `TCP:127.0.0.1:${port}`,
], { stdio: "inherit" });
relay.once("exit", (code) => {
  app.kill("SIGTERM");
  process.exit(code ?? 1);
});
process.stdout.write(`OPENFLOOR_PREVIEW_READY ${port}\n`);

async function discoverSingleHttpPort(child) {
  const deadline = Date.now() + 90_000;
  let firstDetectedAt = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("Preview app exited before opening an HTTP listener.");
    const ports = await listeningPorts();
    const httpPorts = [];
    for (const candidate of ports) if (await respondsWithHttp(candidate)) httpPorts.push(candidate);
    const selected = selectSingleHttpPort(httpPorts);
    if (selected != null) {
      firstDetectedAt ??= Date.now();
      if (Date.now() - firstDetectedAt >= 2_000) return selected;
    } else {
      firstDetectedAt = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Preview app did not open one HTTP listener within 90 seconds.");
}

async function listeningPorts() {
  const ports = new Set();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const lines = (await readFile(path, "utf8")).trim().split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== "0A") continue;
      const port = Number.parseInt(fields[1].split(":")[1], 16);
      if (port >= 1024 && port <= 65535) ports.add(port);
    }
  }
  return [...ports];
}

function respondsWithHttp(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/", timeout: 750 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.once("timeout", () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
  });
}

function safeRuntimeEnvironment() {
  return {
    HOME: "/home/openfloor-agent",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

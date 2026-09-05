import { spawn } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { selectSingleHttpPort } from "./repository-preview.mjs";

const COMMANDS = {
  npm: (script) => ["npm", ["run", script]],
  pnpm: (script) => ["pnpm", ["run", script]],
  yarn: (script) => ["yarn", ["run", script]],
  bun: (script) => ["bun", ["run", script]],
};
const SOCKET_DIRECTORY = "/workspace/preview-relay";
const SOCKET_PATH = `${SOCKET_DIRECTORY}/preview.sock`;
const manager = process.argv[2];
const script = process.argv[3];
if (!(manager in COMMANDS) || !["dev", "start"].includes(script)) {
  throw new Error("Unsupported preview runtime selection.");
}

const reservedPorts = proxyPorts(process.env);
let targetPort = null;
let resolveTargetPort;
const targetPortReady = new Promise((resolve) => { resolveTargetPort = resolve; });
const relay = http.createServer(async (request, response) => {
  const port = targetPort ?? await targetPortReady;
  const upstream = http.request({
    host: "127.0.0.1",
    port,
    method: request.method,
    path: request.url,
    headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage ?? "Bad Gateway",
      upstreamResponse.rawHeaders,
    );
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.once("aborted", () => upstream.destroy());
  request.pipe(upstream);
});
relay.on("upgrade", async (request, client, head) => {
  const port = targetPort ?? await targetPortReady;
  if (client.destroyed) return;
  const upstream = net.connect(port, "127.0.0.1", () => {
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  const close = () => { upstream.destroy(); client.destroy(); };
  upstream.once("error", close);
  client.once("error", close);
});

await unlink(SOCKET_PATH).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
});
await new Promise((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(SOCKET_PATH, () => {
    relay.off("error", reject);
    resolve();
  });
});
process.stdout.write("OPENFLOOR_PREVIEW_SOCKET_BOUND\n");
await waitForRelayLock();

const [command, args] = COMMANDS[manager](script);
const app = spawn(command, args, {
  cwd: "/workspace/repository",
  stdio: "inherit",
  env: safeRuntimeEnvironment(),
});
app.once("exit", (code) => {
  process.stderr.write(`Preview app exited before relay was ready (${code ?? "signal"}).\n`);
  process.exit(code ?? 1);
});

targetPort = await discoverSingleHttpPort(app, reservedPorts);
resolveTargetPort(targetPort);
process.stdout.write(`OPENFLOOR_PREVIEW_READY ${targetPort}\n`);

async function waitForRelayLock() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const metadata = await stat(SOCKET_DIRECTORY);
    if (metadata.uid === 0 && (metadata.mode & 0o222) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Preview relay directory was not locked.");
}

async function discoverSingleHttpPort(child, excludedPorts) {
  const deadline = Date.now() + 90_000;
  let firstDetectedAt = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("Preview app exited before opening an HTTP listener.");
    const ports = (await listeningPorts()).filter((port) => !excludedPorts.has(port));
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

function proxyPorts(environment) {
  const ports = new Set();
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    const value = environment[name];
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
        const port = Number(url.port);
        if (Number.isSafeInteger(port) && port > 0) ports.add(port);
      }
    } catch { /* invalid proxy setting is ignored */ }
  }
  return ports;
}

function safeRuntimeEnvironment() {
  return {
    HOME: "/tmp/openfloor/workspace-home",
    PATH: "/workspace/repository/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

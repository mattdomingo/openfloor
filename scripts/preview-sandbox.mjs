import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { createRegistryProxy } from "./runtime-broker.mjs";
import { startSandbox } from "./runtime-sandbox.mjs";

const RELAY_PORT = 8080;
const SOCKET_DIRECTORY = "/workspace/preview-relay";
const SOCKET_PATH = `${SOCKET_DIRECTORY}/preview.sock`;
const PREVIEW_FILES = ["preview-runtime.mjs", "repository-preview.mjs"];

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForSocket(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (statSync(SOCKET_PATH).isSocket()) return;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Preview relay socket was not created.");
}

function lockRelaySocket() {
  chownSync(SOCKET_DIRECTORY, 0, 0);
  chmodSync(SOCKET_DIRECTORY, 0o555);
  chownSync(SOCKET_PATH, 0, 10001);
  chmodSync(SOCKET_PATH, 0o660);
}

function listenRelay() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(SOCKET_PATH);
      const close = () => { upstream.destroy(); client.destroy(); };
      upstream.on("error", close);
      client.on("error", close);
      client.pipe(upstream).pipe(client);
    });
    server.once("error", reject);
    server.listen(RELAY_PORT, "0.0.0.0", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function installPreview(root, outputPath) {
  const directory = mkdtempSync("/run/openfloor-broker-");
  const socket = `${directory}/broker.sock`;
  const proxy = createRegistryProxy();
  proxy.listen(socket, () => {
    chmodSync(socket, 0o600);
    chownSync(socket, 10002, 10001);
    const child = startSandbox(
      ["node", "/opt/openfloor/runtime-bridge.mjs", "node", "/opt/openfloor/repository-preview.mjs", "--install", root, outputPath].filter(Boolean),
      {
        HTTPS_PROXY: "http://127.0.0.1:45871",
        HTTP_PROXY: "http://127.0.0.1:45871",
        NO_PROXY: "127.0.0.1,localhost",
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
        YARN_NPM_REGISTRY_SERVER: "https://registry.npmjs.org",
        HOME: "/tmp/openfloor/workspace-home",
      },
      { brokerPath: socket, extraRoFiles: ["repository-preview.mjs"] },
    );
    const finish = (code) => {
      proxy.closeAllConnections();
      proxy.close();
      rmSync(directory, { recursive: true, force: true });
      process.exitCode = code ?? 1;
    };
    child.on("error", () => finish(1));
    child.on("exit", finish);
  });
  proxy.on("error", () => {
    rmSync(directory, { recursive: true, force: true });
    process.exitCode = 1;
  });
}

async function runPreview(manager, script) {
  mkdirSync(SOCKET_DIRECTORY, { recursive: true });
  mkdirSync("/tmp/openfloor/workspace-home", { recursive: true });
  try { unlinkSync(SOCKET_PATH); } catch { /* absent */ }
  chownSync("/workspace", 10002, 10001);
  chownSync(SOCKET_DIRECTORY, 10002, 10001);
  chownSync("/tmp/openfloor", 10002, 10001);
  chmodSync(SOCKET_DIRECTORY, 0o700);
  const child = startSandbox(
    ["node", "/opt/openfloor/preview-runtime.mjs", manager, script],
    { HOME: "/tmp/openfloor/workspace-home" },
    { loopback: true, extraRoFiles: PREVIEW_FILES, extraBinds: [SOCKET_DIRECTORY] },
  );
  const finished = waitForExit(child);
  try {
    await waitForSocket(90_000);
    lockRelaySocket();
    const relay = await listenRelay();
    const result = await finished;
    relay.close();
    process.exitCode = result.code ?? 1;
  } catch (error) {
    child.kill("SIGTERM");
    await finished.catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === "install") {
    installPreview(process.argv[3] ?? "/workspace/repository", process.argv[4] ?? "/tmp/openfloor/preview-config.json");
  } else if (mode === "run") {
    const manager = process.argv[3];
    const script = process.argv[4];
    if (!["npm", "pnpm", "yarn", "bun"].includes(manager) || !["dev", "start"].includes(script)) {
      throw new Error("Unsupported preview runtime selection.");
    }
    runPreview(manager, script).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Preview runtime failed."}\n`);
      process.exitCode = 1;
    });
  } else {
    throw new Error("Preview sandbox requires install or run.");
  }
}

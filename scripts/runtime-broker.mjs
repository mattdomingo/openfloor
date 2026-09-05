import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { chmodSync, chownSync, mkdtempSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { startSandbox } from "./runtime-sandbox.mjs";

const LOCAL = "http://127.0.0.1:45871";
const MAX_BODY = 32 * 1024 * 1024;
const REQUEST_HEADERS = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta", "x-goog-api-client", "mcp-protocol-version", "mcp-session-id", "last-event-id"]);
const RESPONSE_HEADERS = new Set(["content-type", "content-encoding", "cache-control", "mcp-session-id", "retry-after"]);

/** Credentials and upstream destinations stay in this parent process, never
 * runner configuration, namespace files, process arguments, or child env. */
export function brokerConfiguration(source) {
  const environment = {};
  const routes = [];
  for (const name of ["OPENFLOOR_PROMPT_PATH", "OPENFLOOR_RESULT_PATH", "OPENFLOOR_WORKSPACE", "OPENFLOOR_MODEL", "OPENFLOOR_RUN_MODE", "OPENFLOOR_RESUME_THREAD_ID", "OPENFLOOR_SKILLS", "OPENFLOOR_MCP_SERVER_PATH", "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_SETTINGS_PATH"]) {
    if (source[name]) environment[name] = source[name];
  }
  function route(url, headers, methods, suffix, fixedPrefix) {
    const upstream = new URL(url);
    if (!["https:", "http:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.hash) throw new Error("Invalid broker destination");
    const prefix = fixedPrefix ?? `/r/${routes.length}`;
    routes.push({ prefix, upstream, headers, methods, suffix });
    return `${LOCAL}${prefix}`;
  }
  for (const provider of ["OPENAI", "ANTHROPIC", "GEMINI", "QWEN"]) {
    const base = source[`OPENFLOOR_${provider}_BASE_URL`];
    const token = source[`OPENFLOOR_${provider}_TOKEN`];
    if (!base || !token) continue;
    environment[`OPENFLOOR_${provider}_BASE_URL`] = route(base, { authorization: `Bearer ${token}`, "x-api-key": token, "x-goog-api-key": token }, ["POST", "GET"], true, "/provider");
    environment[`OPENFLOOR_${provider}_TOKEN`] = "openfloor-broker-placeholder";
  }
  for (const [name, methods] of [["EVENTS", ["POST"]], ["CONTEXT", ["GET"]], ["CONFLICT_INPUT", ["POST"]]]) {
    const url = source[`OPENFLOOR_${name}_URL`];
    const token = source[`OPENFLOOR_${name}_TOKEN`];
    if (!url || !token) continue;
    environment[`OPENFLOOR_${name}_URL`] = route(url, { authorization: `Bearer ${token}` }, methods, false, `/${name.toLowerCase().replace("_", "-")}`);
    environment[`OPENFLOOR_${name}_TOKEN`] = "openfloor-broker-placeholder";
  }
  const servers = JSON.parse(source.OPENFLOOR_MCP_SERVERS || "{}");
  const publicServers = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || !["http", "sse"].includes(server.type)) throw new Error("Unsupported broker MCP transport");
    publicServers[name] = { type: server.type, url: route(server.url, server.headers ?? {}, ["POST", "GET", "DELETE"], false) };
    routes[routes.length - 1].sse = server.type === "sse";
  }
  environment.OPENFLOOR_MCP_SERVERS = JSON.stringify(publicServers);
  return { environment, routes };
}

export const REGISTRY_PROXY_TARGET = "registry.npmjs.org:443";

/** Preview installs may reach only the npm registry. Regular HTTP is refused;
 * CONNECT to any other host:port is refused. */
export function createRegistryProxy() {
  const server = http.createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  server.on("connect", (request, clientSocket, head) => {
    if (request.url !== REGISTRY_PROXY_TARGET) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(443, "registry.npmjs.org", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream).pipe(clientSocket);
    });
    const close = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on("error", close);
    clientSocket.on("error", close);
  });
  return server;
}

export function createBroker(routes) {
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    let path;
    try {
      path = request.url ?? "";
      const decoded = decodeURIComponent(path.split("?", 1)[0]);
      if (!path.startsWith("/") || path.length > 4096 || /[\\\x00-\x20]/.test(decoded) || decoded.includes("%") || decoded.split("/").some((part) => part === "." || part === "..")) throw new Error();
    } catch { response.writeHead(400); response.end(); return; }
    const route = [...routes].reverse().find((entry) => path === entry.prefix || path.startsWith(`${entry.prefix}/`) || path.startsWith(`${entry.prefix}?`));
    if (!route || !route.methods.includes(request.method)) { response.writeHead(403); response.end(); return; }
    const tail = path.slice(route.prefix.length);
    if (!route.suffix && tail && !tail.startsWith("?")) { response.writeHead(403); response.end(); return; }
    // Concatenate only an already validated relative suffix. Never accept a
    // caller URL, Host, Authorization, redirect target, or proxy destination.
    const target = new URL(route.upstream.href);
    const query = tail.indexOf("?");
    const parameters = new URLSearchParams(query < 0 ? "" : tail.slice(query + 1));
    // Exact MCP/control routes keep their private query intact. Provider APIs
    // may add transport parameters, but cannot replace configured parameters.
    if (parameters.size && (!route.suffix || [...parameters.keys()].some((key) => target.searchParams.has(key)))) {
      response.writeHead(403); response.end(); return;
    }
    if (tail.startsWith("/")) {
      const split = tail.indexOf("?");
      target.pathname = target.pathname.replace(/\/$/, "") + (split < 0 ? tail : tail.slice(0, split));
    }
    for (const [key, value] of parameters) target.searchParams.append(key, value);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => REQUEST_HEADERS.has(name)));
    Object.assign(headers, route.headers);
    if (route.sse) headers["accept-encoding"] = "identity";
    const upstream = (target.protocol === "https:" ? https : http).request(target, { method: request.method, headers }, (incoming) => {
      // Redirects are never followed; do not pass signed redirect locations or
      // credential-bearing response headers into the untrusted namespace.
      if ((incoming.statusCode ?? 0) >= 300 && (incoming.statusCode ?? 0) < 400) { incoming.destroy(); response.writeHead(502); response.end(); return; }
      response.writeHead(incoming.statusCode ?? 502, Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => RESPONSE_HEADERS.has(name))));
      if (route.sse && request.method === "GET" && String(incoming.headers["content-type"]).includes("text/event-stream")) {
        const rewrite = endpointEvents(route, routes);
        rewrite.on("error", () => { incoming.destroy(); response.destroy(); });
        incoming.pipe(rewrite).pipe(response);
      } else incoming.pipe(response);
      incoming.on("error", () => response.destroy());
    });
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        request.unpipe(upstream);
        upstream.destroy();
        if (!response.headersSent) { response.writeHead(413); response.end(); }
        else response.destroy();
      }
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connect", (_request, clientSocket) => {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.destroy();
  });
  return server;
}

// Legacy SSE MCP announces its POST endpoint in an event. Rewrite only that
// event, granting a route to the server-announced same-origin destination.
// Credentials and server session query parameters stay outside the namespace.
function endpointEvents(route, routes) {
  let buffered = "";
  const decoder = new StringDecoder("utf8");
  return new Transform({
    transform(chunk, encoding, callback) {
      buffered += decoder.write(chunk);
      if (buffered.length > 1024 * 1024) return callback(new Error("MCP event exceeds limit"));
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffered);
        if (!boundary) break;
        let frame = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary[0].length);
        if (/^event: *endpoint\r?$/m.test(frame)) {
          if ((frame.match(/^data:/gm) ?? []).length !== 1) return callback(new Error("Invalid MCP endpoint data"));
          const data = /^data: *(.*)\r?$/m.exec(frame)?.[1]?.trim();
          if (!data) return callback(new Error("Missing MCP endpoint"));
          let target;
          try { target = new URL(data, route.upstream); }
          catch { return callback(new Error("Invalid MCP endpoint")); }
          if (target.origin !== route.upstream.origin || target.username || target.password || target.hash) return callback(new Error("MCP endpoint changed origin"));
          if (routes.length >= 256) return callback(new Error("Too many MCP endpoints"));
          const prefix = `${route.prefix}/endpoint/${routes.length}`;
          routes.push({ prefix, upstream: target, headers: route.headers, methods: ["POST"], suffix: false });
          frame = frame.replace(/^data:.*$/m, `data: ${LOCAL}${prefix}`);
        }
        this.push(frame + "\n\n");
      }
      callback();
    },
    // An incomplete frame might contain a private endpoint; never forward it.
    flush(callback) { buffered += decoder.end(); callback(); },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runner = process.argv[2];
  if (!["codex", "claude", "gemini", "qwen"].includes(runner)) throw new Error("Invalid provider runner");
  const { environment, routes } = brokerConfiguration(process.env);
  const directory = mkdtempSync("/run/openfloor-broker-");
  const socket = `${directory}/broker.sock`;
  const broker = createBroker(routes);
  broker.listen(socket, () => {
    chmodSync(socket, 0o600); chownSync(socket, 10002, 10001);
    const child = startSandbox(["node", "/opt/openfloor/runtime-bridge.mjs", "node", `/opt/openfloor/${runner}-runner.mjs`], environment, { brokerPath: socket, readOnly: process.env.OPENFLOOR_RUN_MODE === "reply" });
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
    let finished = false;
    const finish = (code) => { if (finished) return; finished = true; broker.closeAllConnections(); broker.close(); rmSync(directory, { recursive: true, force: true }); process.exitCode = code ?? 1; };
    child.on("error", () => finish(1));
    child.on("exit", finish);
  });
  broker.on("error", () => { rmSync(directory, { recursive: true, force: true }); process.exitCode = 1; });
}

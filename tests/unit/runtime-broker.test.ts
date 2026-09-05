import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { brokerConfiguration, createBroker, createRegistryProxy } from "../../scripts/runtime-broker.mjs";

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

// Retain bytes received before a deliberately aborted SSE response, so an
// aborted transport cannot hide a leaked endpoint in the test assertion.
async function receive(url: string) {
  return new Promise<{ text: string; aborted: boolean }>((resolve) => {
    let text = "";
    const request = http.get(url, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ text, aborted: false }));
      response.on("error", () => resolve({ text, aborted: true }));
    });
    request.on("error", () => resolve({ text, aborted: true }));
  });
}

describe("credential broker boundary", () => {
  it("keeps upstream URLs, gateway credentials and MCP headers out of runner environment", () => {
    const config = brokerConfiguration({ OPENFLOOR_OPENAI_BASE_URL: "https://runtime.example/model/v1", OPENFLOOR_OPENAI_TOKEN: "gateway-secret", OPENFLOOR_CONTEXT_URL: "https://runtime.example/context", OPENFLOOR_CONTEXT_TOKEN: "context-secret", OPENFLOOR_MCP_SERVERS: JSON.stringify({ remote: { type: "http", url: "https://mcp.example/private", headers: { authorization: "mcp-secret" } } }), RUNTIME_GATEWAY_SECRET: "signing-secret", NODE_OPTIONS: "untrusted-preload", OPENFLOOR_MODEL: "model" });
    const visible = JSON.stringify(config.environment);
    for (const privateValue of ["gateway-secret", "context-secret", "mcp-secret", "signing-secret", "untrusted-preload", "runtime.example", "mcp.example"]) expect(visible).not.toContain(privateValue);
    const environment = config.environment as unknown as Record<string, string>;
    expect(environment.OPENFLOOR_OPENAI_TOKEN).toBe("openfloor-broker-placeholder");
    expect(environment.OPENFLOOR_CONTEXT_URL).toBe("http://127.0.0.1:45871/context");
  });

  it("pins transport, strips caller credentials, streams responses and refuses path escapes", async () => {
    const seen: Array<{ path: string; authorization?: string; other?: string }> = [];
    const upstream = await listen(http.createServer((request, response) => {
      seen.push({ path: request.url!, authorization: request.headers.authorization, other: request.headers["x-private"] as string | undefined });
      response.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "private-cookie", authorization: "private-response" });
      response.write("data: first\n\n"); response.end("data: last\n\n");
    }));
    const config = brokerConfiguration({ OPENFLOOR_OPENAI_BASE_URL: `${upstream}/model/v1`, OPENFLOOR_OPENAI_TOKEN: "server-only" });
    const broker = await listen(createBroker(config.routes));
    const response = await fetch(`${broker}/provider/responses`, { method: "POST", headers: { authorization: "caller-token", "x-private": "caller-header" }, body: "{}" });
    expect(await response.text()).toBe("data: first\n\ndata: last\n\n");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    expect(seen).toEqual([{ path: "/model/v1/responses", authorization: "Bearer server-only", other: undefined }]);
    for (const path of ["/unknown", "/provider/%252e%252e/context", "/provider/%5csecret", "/provider/%2e%2e%2fcontext"]) expect((await fetch(broker + path, { method: "POST" })).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${broker}/provider/responses`, { method: "DELETE" })).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it("does not follow or expose upstream redirects", async () => {
    const upstream = await listen(http.createServer((_request, response) => { response.writeHead(302, { location: "https://elsewhere.example?token=private" }); response.end(); }));
    const config = brokerConfiguration({ OPENFLOOR_CONTEXT_URL: upstream, OPENFLOOR_CONTEXT_TOKEN: "private" });
    const broker = await listen(createBroker(config.routes));
    const response = await fetch(`${broker}/context`);
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });

  it("preserves configured provider parameters while allowing additional transport parameters", async () => {
    const seen: string[] = [];
    const upstream = await listen(http.createServer((request, response) => { seen.push(request.url!); response.end("ok"); }));
    const config = brokerConfiguration({ OPENFLOOR_OPENAI_BASE_URL: `${upstream}/v1?key=private-key`, OPENFLOOR_OPENAI_TOKEN: "private" });
    const broker = await listen(createBroker(config.routes));
    expect((await fetch(`${broker}/provider/responses?stream=true&transport=a&transport=b`, { method: "POST" })).status).toBe(200);
    for (const query of ["key=replacement", "%6bey=replacement", "key=&key=replacement"]) {
      expect((await fetch(`${broker}/provider/responses?${query}`, { method: "POST" })).status).toBe(403);
    }
    expect(seen).toEqual(["/v1/responses?key=private-key&stream=true&transport=a&transport=b"]);
  });

  it("pins exact MCP routes including their private query", async () => {
    const seen: string[] = [];
    const upstream = await listen(http.createServer((request, response) => { seen.push(request.url!); response.end("ok"); }));
    const config = brokerConfiguration({ OPENFLOOR_MCP_SERVERS: JSON.stringify({ remote: { type: "http", url: `${upstream}/mcp?session=private-session` } }) });
    const broker = await listen(createBroker(config.routes));
    expect((await fetch(`${broker}/r/0`, { method: "POST" })).status).toBe(200);
    for (const tail of ["?session=replacement", "?added=value", "/other"]) expect((await fetch(`${broker}/r/0${tail}`, { method: "POST" })).status).toBe(403);
    expect(seen).toEqual(["/mcp?session=private-session"]);
  });

  it("keeps legacy SSE MCP endpoint credentials outside the namespace", async () => {
    const seen: string[] = [];
    const upstream = await listen(http.createServer((request, response) => {
      seen.push(request.url!);
      if (request.method === "GET") { response.writeHead(200, { "content-type": "text/event-stream" }); response.end("event: endpoint\ndata: /messages?session=private-session\n\n"); }
      else { expect(request.headers.authorization).toBe("mcp-secret"); response.end("accepted"); }
    }));
    const config = brokerConfiguration({ OPENFLOOR_MCP_SERVERS: JSON.stringify({ remote: { type: "sse", url: `${upstream}/sse`, headers: { authorization: "mcp-secret" } } }) });
    const broker = await listen(createBroker(config.routes));
    const frame = await (await fetch(`${broker}/r/0`)).text();
    expect(frame).not.toContain("private-session");
    const endpoint = /data: (.*)/.exec(frame)![1];
    expect(await (await fetch(broker + new URL(endpoint).pathname, { method: "POST", body: "{}" })).text()).toBe("accepted");
    expect((await fetch(broker + new URL(endpoint).pathname + "?session=changed", { method: "POST" })).status).toBe(403);
    expect(seen).toEqual(["/sse", "/messages?session=private-session"]);
  });

  it.each([
    ["malformed URL", "event: endpoint\ndata: http://[private-session\n\n"],
    ["multiline data", "event: endpoint\ndata: /messages\ndata: ?session=private-session\n\n"],
    ["foreign origin", "event: endpoint\ndata: https://foreign.example/?session=private-session\n\n"],
    ["missing data", "event: endpoint\n\n"],
  ])("rejects %s SSE endpoints without leaking bytes or killing the broker", async (_name, frame) => {
    const upstream = await listen(http.createServer((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(frame); }));
    const config = brokerConfiguration({ OPENFLOOR_MCP_SERVERS: JSON.stringify({ remote: { type: "sse", url: `${upstream}/sse` } }) });
    const broker = await listen(createBroker(config.routes));
    const received = await receive(`${broker}/r/0`);
    expect(received).toEqual({ text: "", aborted: true });
    expect(config.routes).toHaveLength(1);
    expect((await fetch(`${broker}/unknown`)).status).toBe(403);
  });

  it("drops truncated SSE endpoints without disclosing their private query", async () => {
    const upstream = await listen(http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("event: message\ndata: safe\n\nevent: endpoint\ndata: /messages?session=private-session");
    }));
    const config = brokerConfiguration({ OPENFLOOR_MCP_SERVERS: JSON.stringify({ remote: { type: "sse", url: `${upstream}/sse` } }) });
    const broker = await listen(createBroker(config.routes));
    expect(await receive(`${broker}/r/0`)).toEqual({ text: "event: message\ndata: safe\n\n", aborted: false });
    expect(config.routes).toHaveLength(1);
    expect((await fetch(`${broker}/unknown`)).status).toBe(403);
  });

  it("preserves UTF-8 code points split between upstream SSE chunks", async () => {
    const frame = "event: message\ndata: café 🪨\n\n";
    const encoded = Buffer.from(frame);
    const split = encoded.indexOf(Buffer.from("🪨")) + 2;
    const upstream = await listen(http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(encoded.subarray(0, split), () => { setImmediate(() => response.end(encoded.subarray(split))); });
    }));
    const config = brokerConfiguration({ OPENFLOOR_MCP_SERVERS: JSON.stringify({ remote: { type: "sse", url: `${upstream}/sse` } }) });
    const broker = await listen(createBroker(config.routes));
    expect(await (await fetch(`${broker}/r/0`)).text()).toBe(frame);
  });
});

describe("preview registry proxy", () => {
  it("refuses ordinary HTTP and CONNECT to any host except the npm registry", async () => {
    const proxy = await listen(createRegistryProxy());
    expect((await fetch(proxy)).status).toBe(403);
    const url = new URL(proxy);
    const forbidden = await new Promise<number>((resolve) => {
      const request = http.request({
        host: url.hostname,
        port: url.port,
        method: "CONNECT",
        path: "1.1.1.1:443",
      });
      request.on("connect", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode ?? 200);
      });
      request.on("error", () => resolve(403));
      request.on("response", (response) => resolve(response.statusCode ?? 0));
      request.end();
    });
    expect(forbidden).toBeGreaterThanOrEqual(400);
  });

  it("refuses CONNECT on the ordinary run broker", async () => {
    const broker = await listen(createBroker([]));
    const url = new URL(broker);
    const status = await new Promise<number>((resolve) => {
      const request = http.request({
        host: url.hostname,
        port: url.port,
        method: "CONNECT",
        path: "registry.npmjs.org:443",
      });
      request.on("connect", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode ?? 200);
      });
      request.on("error", () => resolve(403));
      request.on("response", (response) => resolve(response.statusCode ?? 0));
      request.end();
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

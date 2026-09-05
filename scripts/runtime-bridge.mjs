import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const BROKER = "/run/openfloor-broker.sock";

// This process owns the provider lifetime inside the execution namespace. It holds no upstream
// URL or secret; the Unix socket exposes only the fixed per-run broker routes.
const bridge = http.createServer((request, response) => {
  const upstream = http.request({ socketPath: BROKER, path: request.url, method: request.method, headers: request.headers }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(response);
    incoming.on("error", () => response.destroy());
  });
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
});
bridge.on("connect", (request, clientSocket, head) => {
  const upstream = net.connect({ path: BROKER });
  const close = () => { upstream.destroy(); clientSocket.destroy(); };
  upstream.on("error", close);
  clientSocket.on("error", close);
  upstream.on("connect", () => {
    upstream.write(`CONNECT ${request.url} HTTP/1.1\r\nHost: ${request.url}\r\n\r\n`);
    let buffered = Buffer.from(head);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const split = buffered.indexOf("\r\n\r\n");
      if (split < 0) return;
      upstream.off("data", onData);
      const header = buffered.subarray(0, split).toString("latin1");
      const rest = buffered.subarray(split + 4);
      if (!/^HTTP\/1\.[01] 200 /m.test(header)) {
        clientSocket.end(buffered);
        close();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) clientSocket.write(rest);
      clientSocket.pipe(upstream).pipe(clientSocket);
    };
    upstream.on("data", onData);
  });
});
bridge.listen(45871, "127.0.0.1", () => {
  const child = spawn(process.argv[2], process.argv.slice(3), { env: process.env, stdio: "inherit" });
  child.on("error", () => process.exit(1));
  child.on("exit", (code) => process.exit(code ?? 1));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    child.kill(signal);
    setTimeout(() => process.exit(130), 8000).unref();
  });
});
bridge.on("error", () => process.exit(1));

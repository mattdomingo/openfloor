import http from "node:http";
import { spawn } from "node:child_process";

// This process owns the provider lifetime inside the execution namespace. It holds no upstream
// URL or secret; the Unix socket exposes only the fixed per-run broker routes.
const bridge = http.createServer((request, response) => {
  const upstream = http.request({ socketPath: "/run/openfloor-broker.sock", path: request.url, method: request.method, headers: request.headers }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(response);
    incoming.on("error", () => response.destroy());
  });
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
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

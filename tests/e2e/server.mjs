import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const statePath = mkdtempSync(join(tmpdir(), "openfloor-e2e-"));
const wranglerArgs = ["wrangler", "--config", "dist/server/wrangler.json"];
const migration = spawnSync(
  "npx",
  [...wranglerArgs.slice(0, 1), "d1", "execute", "DB", "--local", "--config", "dist/server/wrangler.json", "--persist-to", statePath, "--file", "drizzle/0000_burly_champions.sql"],
  { stdio: "inherit" },
);

if (migration.status !== 0) {
  rmSync(statePath, { recursive: true, force: true });
  process.exit(migration.status ?? 1);
}

const server = spawn("npx", [
  "wrangler",
  "dev",
  "--config",
  "dist/server/wrangler.json",
  "--port",
  "8787",
  "--persist-to",
  statePath,
  "--var",
  "INVITE_SIGNING_SECRET:e2e-test-secret",
  "--show-interactive-dev-session=false",
], { stdio: "inherit" });

function stop(signal) {
  server.kill(signal);
  rmSync(statePath, { recursive: true, force: true });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
server.on("exit", (code) => {
  rmSync(statePath, { recursive: true, force: true });
  process.exit(code ?? 0);
});

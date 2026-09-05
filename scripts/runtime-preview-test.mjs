import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { sandboxArguments } from "./runtime-sandbox.mjs";

const scratch = "/tmp/openfloor-preview-isolation";
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
  const fixture = `${scratch}/${manager}`;
  mkdirSync(`${fixture}/dependency`, { recursive: true });
  writeFileSync(`${fixture}/dependency/package.json`, JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }));
  let managerVersion = "1.0.0";
  if (manager === "npm") managerVersion = spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim();
  if (manager === "pnpm") managerVersion = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).stdout.trim();
  if (manager === "yarn") managerVersion = spawnSync("yarn", ["--version"], { encoding: "utf8" }).stdout.trim();
  if (manager === "bun") managerVersion = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(`${fixture}/package.json`, JSON.stringify({
    name: `preview-${manager}`,
    version: "1.0.0",
    private: true,
    packageManager: `${manager}@${managerVersion}`,
    scripts: { preinstall: "touch lifecycle-ran", dev: "node server.mjs" },
    dependencies: { "fixture-dependency": "file:./dependency" },
  }));
  if (manager === "npm") spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit"], { cwd: fixture, stdio: "ignore" });
  if (manager === "pnpm") spawnSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: fixture, stdio: "ignore" });
  if (manager === "yarn") spawnSync("yarn", ["install", "--mode=skip-build"], { cwd: fixture, stdio: "ignore" });
  if (manager === "bun") spawnSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: fixture, stdio: "ignore" });
  spawnSync("chown", ["-R", "10002:10001", fixture]);
  const result = spawnSync("/usr/bin/bwrap", sandboxArguments(
    ["node", "/opt/openfloor/repository-preview.mjs", "--install", fixture, `${fixture}/config.json`],
    { HOME: "/tmp/openfloor/workspace-home" },
    { extraRoFiles: ["repository-preview.mjs"] },
  ), { encoding: "utf8", timeout: 60_000, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert(!existsSync(`${fixture}/lifecycle-ran`));
  assert.match(readFileSync(`${fixture}/config.json`, "utf8"), new RegExp(`"packageManager":"${manager}"`));
}

rmSync("/workspace/repository", { recursive: true, force: true });
mkdirSync("/workspace/repository", { recursive: true });
mkdirSync("/tmp/openfloor/workspace-home", { recursive: true });
spawnSync("chown", ["-R", "10002:10001", "/workspace", "/tmp/openfloor"]);

const loopback = spawnSync("/usr/bin/bwrap", sandboxArguments(
  ["node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import http from 'node:http';
    import net from 'node:net';
    assert.equal(process.getuid(), 10002);
    const status = fs.readFileSync('/proc/self/status','utf8');
    for (const capability of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.match(status, new RegExp(capability + ':\\\\s+0+'));
    await new Promise((resolve, reject) => {
      const server = http.createServer((_request, response) => response.end('preview-loopback'));
      server.listen(3456, '127.0.0.1', () => {
        http.get('http://127.0.0.1:3456/', (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            assert.equal(body, 'preview-loopback');
            const remote = net.connect({ host: '1.1.1.1', port: 443 });
            remote.on('connect', () => { remote.destroy(); reject(new Error('Preview escaped')); });
            remote.on('error', resolve);
            remote.setTimeout(1000, () => { remote.destroy(); resolve(); });
          });
        }).on('error', reject);
      });
    });
  `],
  { HOME: "/tmp/openfloor/workspace-home" },
  { loopback: true },
), { encoding: "utf8", timeout: 15_000, env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
assert.equal(loopback.status, 0, loopback.stderr || loopback.error?.message);

console.log("runtime-preview-ok: package managers, lifecycle suppression, loopback, zero capabilities, blocked outbound");

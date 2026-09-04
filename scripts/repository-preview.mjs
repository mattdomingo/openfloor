import { access, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";

export const MAX_PACKAGE_JSON_BYTES = 1_048_576;

const MANAGERS = {
  npm: { locks: ["package-lock.json", "npm-shrinkwrap.json"], install: ["npm", "ci", "--ignore-scripts"], run: (script) => ["npm", "run", script] },
  pnpm: { locks: ["pnpm-lock.yaml"], install: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], run: (script) => ["pnpm", "run", script] },
  yarn: { locks: ["yarn.lock"], install: ["yarn", "install", "--immutable", "--mode=skip-build"], run: (script) => ["yarn", "run", script] },
  bun: { locks: ["bun.lock", "bun.lockb"], install: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"], run: (script) => ["bun", "run", script] },
};

export function detectRepositoryPreview(manifest, rootFiles) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Root package.json must contain a JSON object.");
  }
  const locks = [];
  let lockfileCount = 0;
  for (const [manager, config] of Object.entries(MANAGERS)) {
    const present = config.locks.filter((name) => rootFiles.has(name));
    lockfileCount += present.length;
    if (present.length) locks.push(manager);
  }
  if (locks.length === 0) throw new Error("Root JavaScript preview requires a supported frozen lockfile.");
  if (locks.length > 1 || lockfileCount > 1) throw new Error("Root package manager is ambiguous because multiple lockfiles are present.");
  const manager = locks[0];
  const declaration = manifest.packageManager;
  if (declaration != null) {
    if (typeof declaration !== "string") throw new Error("packageManager must be a string when present.");
    const declaredManager = declaration.trim().match(/^(npm|pnpm|yarn|bun)@[^\s]+$/)?.[1];
    if (!declaredManager) throw new Error("packageManager must name npm, pnpm, Yarn, or Bun with a version.");
    if (declaredManager !== manager) throw new Error("packageManager conflicts with root lockfile.");
  }
  const scripts = manifest.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error("Root package.json has no supported dev or start script.");
  }
  const script = typeof scripts.dev === "string" && scripts.dev.trim() ? "dev"
    : typeof scripts.start === "string" && scripts.start.trim() ? "start" : null;
  if (!script) throw new Error("Root package.json has no supported dev or start script.");
  const config = MANAGERS[manager];
  return { packageManager: manager, script, installCommand: config.install, runCommand: config.run(script) };
}

export function selectSingleHttpPort(ports) {
  const unique = [...new Set(ports)];
  if (unique.length > 1) throw new Error("Preview app opened multiple HTTP listeners; v1 supports one service.");
  return unique[0] ?? null;
}

export async function detectRepositoryPreviewAt(root) {
  const manifestPath = `${root}/package.json`;
  let metadata;
  try {
    metadata = await stat(manifestPath);
  } catch {
    throw new Error("Root JavaScript preview requires package.json.");
  }
  if (!metadata.isFile() || metadata.size > MAX_PACKAGE_JSON_BYTES) {
    throw new Error(`Root package.json exceeds ${MAX_PACKAGE_JSON_BYTES} bytes.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("Root package.json is invalid JSON.");
  }
  const rootFiles = new Set();
  for (const config of Object.values(MANAGERS)) {
    for (const name of config.locks) {
      try { await access(`${root}/${name}`); rootFiles.add(name); } catch { /* absent */ }
    }
  }
  return detectRepositoryPreview(manifest, rootFiles);
}

async function main() {
  const install = process.argv[2] === "--install";
  const root = process.argv[install ? 3 : 2] ?? "/workspace/repository";
  const outputPath = process.argv[install ? 4 : 3];
  const detected = await detectRepositoryPreviewAt(root);
  if (install) {
    const result = spawnSync(detected.installCommand[0], detected.installCommand.slice(1), {
      cwd: root,
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
        YARN_NPM_REGISTRY_SERVER: "https://registry.npmjs.org",
        YARN_IGNORE_PATH: "1",
      },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Dependency installation failed with exit code ${result.status ?? "unknown"}.`);
  }
  const encoded = `${JSON.stringify(detected)}\n`;
  if (outputPath) await writeFile(outputPath, encoded, { mode: 0o600 });
  process.stdout.write(encoded);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Preview detection failed."}\n`);
    process.exitCode = 1;
  });
}

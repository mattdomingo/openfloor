import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { sandboxArguments } from "./runtime-sandbox.mjs";

// Setup is owned by runtime-isolation-test.mjs, run immediately before this.
// Exercise installed executables, not merely package-directory existence.
const commands = [
  ["Codex", ["/opt/openfloor/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex", "--version"]],
  ["Claude", ["/opt/openfloor/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude", "--version"]],
  ["Gemini", ["node", "/opt/openfloor/node_modules/@google/gemini-cli/bundle/gemini.js", "--version"]],
  ["Qwen", ["node", "/opt/openfloor/node_modules/@qwen-code/qwen-code/cli-entry.js", "--version"]],
];
for (const [name, command] of commands) {
  const result = spawnSync("/usr/bin/bwrap", sandboxArguments(command), { encoding: "utf8", timeout: 60_000, env: { PATH: "/usr/bin:/bin" } });
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.error?.message}`);
  assert.match(result.stdout, /\d+\.\d+/);
  console.log(`${name}: ${result.stdout.trim()}`);
}

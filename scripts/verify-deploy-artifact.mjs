// The E2E harness builds the app with tests/e2e/wrangler.jsonc into the same
// dist/ directory the production deploy reads, so dist/server/wrangler.json can
// legitimately hold a config whose vars enable OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS
// (arbitrary-identity impersonation) and AGENT_RUN_ENABLED. Deploying a stale
// artifact must fail loudly instead of depending on the worker-name mismatch.
// Run this between `npm run build` and `wrangler deploy`.
import { readFileSync } from "node:fs";

const ARTIFACT = "dist/server/wrangler.json";
const EXPECTED_NAME = "openfloor";
const EXPECTED_ROUTE = "app.opnflr.com";
const EXPECTED_DATABASE = "openfloor-production";
const FORBIDDEN_VAR_PREFIXES = ["OPENFLOOR_TEST_", "OPENFLOOR_E2E_"];

let config;
try {
  config = JSON.parse(readFileSync(ARTIFACT, "utf8"));
} catch (error) {
  fail(`Cannot read ${ARTIFACT}: ${error.message}. Run \`npm run build\` first.`);
}

const problems = [];
if (config.name !== EXPECTED_NAME) {
  problems.push(`worker name is "${config.name}", expected "${EXPECTED_NAME}"`);
}
if (!(config.routes ?? []).some((route) => route?.pattern === EXPECTED_ROUTE && route?.custom_domain === true)) {
  problems.push(`no custom-domain route for ${EXPECTED_ROUTE}`);
}
const database = (config.d1_databases ?? []).find((binding) => binding?.binding === "DB");
if (database?.database_name !== EXPECTED_DATABASE) {
  problems.push(`DB binding points at "${database?.database_name ?? "nothing"}", expected "${EXPECTED_DATABASE}"`);
}
for (const name of Object.keys(config.vars ?? {})) {
  if (FORBIDDEN_VAR_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    problems.push(`test-only var ${name} is present`);
  }
}

if (problems.length > 0) {
  fail(`${ARTIFACT} is not the production build:\n  - ${problems.join("\n  - ")}\nRebuild with \`npm run build\` before deploying.`);
}

console.log(`${ARTIFACT} verified as the production ${EXPECTED_NAME} artifact.`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

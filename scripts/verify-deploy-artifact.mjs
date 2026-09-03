// The E2E harness builds the app with tests/e2e/wrangler.jsonc into the same
// dist/ directory deployments read, so a stale artifact may contain arbitrary
// test identity or execution settings. Verify the complete environment identity
// between the final build and each deploy. Production remains the default for
// the documented emergency command; pass `development` for the release lane.
import { readFileSync } from "node:fs";

const ARTIFACT = "dist/server/wrangler.json";
const FORBIDDEN_VAR_PREFIXES = ["OPENFLOOR_TEST_", "OPENFLOOR_E2E_"];
const TARGETS = {
  production: {
    environment: null,
    name: "openfloor",
    route: "app.opnflr.com",
    databaseName: "openfloor-production",
    databaseId: "1e5059bf-1f7b-4be8-8ea4-c424a191070a",
    r2Buckets: {
      PREFLIGHT_LOGS: "openfloor-preflight-logs",
      USER_AVATARS: "openfloor-user-avatars",
    },
    workflows: {
      REPOSITORY_PREFLIGHT: "openfloor-repository-preflight",
      AGENT_RUN_WORKFLOW: "openfloor-agent-run",
    },
    vars: {
      OPENFLOOR_RUNTIME_ORIGIN: "https://app.opnflr.com",
      AGENT_RUN_ENABLED: "true",
    },
  },
  development: {
    environment: "development",
    name: "openfloor-development",
    route: "dev.app.opnflr.com",
    databaseName: "openfloor-development",
    databaseId: "fe7e3046-8cd8-4aae-a226-87534b2d9f15",
    r2Buckets: {
      PREFLIGHT_LOGS: "openfloor-development-preflight-logs",
      USER_AVATARS: "openfloor-development-user-avatars",
    },
    workflows: {
      REPOSITORY_PREFLIGHT: "openfloor-development-repository-preflight",
      AGENT_RUN_WORKFLOW: "openfloor-development-agent-run",
    },
    vars: {
      OPENFLOOR_RUNTIME_ORIGIN: "https://dev.app.opnflr.com",
      AGENT_RUN_ENABLED: "false",
      STRIPE_CHECKOUT_ENABLED: "false",
      EARLY_ACCESS_GATE_ENABLED: "false",
    },
  },
};

const targetName = process.argv[2] ?? "production";
const target = TARGETS[targetName];
if (!target) {
  fail(`Unknown deployment target "${targetName}". Expected production or development.`);
}

let rootConfig;
try {
  rootConfig = JSON.parse(readFileSync(ARTIFACT, "utf8"));
} catch (error) {
  fail(`Cannot read ${ARTIFACT}: ${error.message}. Run \`npm run build\` first.`);
}

// Source wrangler.jsonc has env.development; vinext emits a flattened artifact.
// Accept the nested form in focused tests, but production deploys always see the
// effective flattened target selected during the build.
const environmentConfig = target.environment ? rootConfig.env?.[target.environment] : null;
const config = environmentConfig ? { ...rootConfig, ...environmentConfig } : rootConfig;
const problems = [];

if (config.name !== target.name) {
  problems.push(`worker name is "${config.name}", expected "${target.name}"`);
}
if (!(config.routes ?? []).some((route) => route?.pattern === target.route && route?.custom_domain === true)) {
  problems.push(`no custom-domain route for ${target.route}`);
}

const database = (config.d1_databases ?? []).find((binding) => binding?.binding === "DB");
if (database?.database_name !== target.databaseName) {
  problems.push(`DB binding points at "${database?.database_name ?? "nothing"}", expected "${target.databaseName}"`);
}
if (database?.database_id !== target.databaseId) {
  problems.push(`DB binding has id "${database?.database_id ?? "nothing"}", expected ${targetName} id "${target.databaseId}"`);
}

for (const [binding, bucketName] of Object.entries(target.r2Buckets)) {
  const bucket = (config.r2_buckets ?? []).find((candidate) => candidate?.binding === binding);
  if (bucket?.bucket_name !== bucketName) {
    problems.push(`${binding} points at "${bucket?.bucket_name ?? "nothing"}", expected "${bucketName}"`);
  }
}
for (const [binding, workflowName] of Object.entries(target.workflows)) {
  const workflow = (config.workflows ?? []).find((candidate) => candidate?.binding === binding);
  if (workflow?.name !== workflowName) {
    problems.push(`${binding} points at "${workflow?.name ?? "nothing"}", expected "${workflowName}"`);
  }
}
for (const [name, expectedValue] of Object.entries(target.vars)) {
  if (config.vars?.[name] !== expectedValue) {
    problems.push(`${name} is "${config.vars?.[name] ?? "missing"}", expected "${expectedValue}"`);
  }
}
for (const name of Object.keys(config.vars ?? {})) {
  if (FORBIDDEN_VAR_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    problems.push(`test-only var ${name} is present`);
  }
}

if (problems.length > 0) {
  fail(`${ARTIFACT} is not the ${targetName} build:\n  - ${problems.join("\n  - ")}\nRebuild with \`npm run build\` before deploying.`);
}

console.log(`${ARTIFACT} verified as the ${targetName} ${target.name} artifact.`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

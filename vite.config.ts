import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const { r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const isE2ePreview = process.env.OPENFLOOR_E2E_PREVIEW === "true";
const e2eStatePath = process.env.OPENFLOOR_E2E_STATE_PATH;
const e2eVarNames = [
  "INVITE_SIGNING_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_STATE_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_MAX_PRICE_ID",
  "STRIPE_PORTAL_CONFIGURATION_ID",
  "STRIPE_CHECKOUT_ENABLED",
  "EARLY_ACCESS_GATE_ENABLED",
  "EARLY_ACCESS_PASSWORD",
  "WAITLIST_SHEET_WEBHOOK_URL",
  "WAITLIST_SHEET_WEBHOOK_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  "OPENFLOOR_TEST_PROVIDER_KEYS",
  "OPENFLOOR_TEST_GITHUB_DATA",
  "PREFLIGHT_ENABLED",
  "AGENT_RUN_ENABLED",
  "OPENFLOOR_TEST_AGENT_RUN_DATA",
  "OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS",
] as const;

function e2eVars() {
  return Object.fromEntries(e2eVarNames.map((name) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`Missing ${name} for the E2E preview server.`);
    return [name, value];
  }));
}

function requiredE2eStatePath() {
  if (!e2eStatePath) throw new Error("Missing OPENFLOOR_E2E_STATE_PATH for the E2E preview server.");
  return e2eStatePath;
}

// compatibility_flags now lives in wrangler.jsonc, which the Cloudflare plugin
// merges on top of this. Setting nodejs_compat in both appends rather than
// dedupes, and the runtime rejects a flag it sees twice.
const localBindingConfig = {
  main: "./worker/index.ts",
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare(isE2ePreview
        ? {
            viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
            configPath: "./tests/e2e/wrangler.jsonc",
            config: {
              main: "../../worker/index.ts",
              vars: e2eVars(),
            },
            persistState: { path: requiredE2eStatePath() },
          }
        : {
            viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
            config: localBindingConfig,
          }),
    ],
  };
});

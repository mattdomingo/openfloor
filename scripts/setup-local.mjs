import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// Run from the repository root after npm ci. Never replace a developer's files.
const localConfig = ".wrangler.local.jsonc";
const { config, error } = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync("wrangler.jsonc", "utf8"),
);
if (error || !config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error("Cannot parse wrangler.jsonc as an object; no local files were written.");
}

if (!existsSync(".dev.vars")) {
  const variables = {
    OPENFLOOR_DEV_USER_ID: "local-user",
    OPENFLOOR_DEV_USER_EMAIL: "developer@example.test",
    OPENFLOOR_DEV_USER_NAME: "Local Developer",
    INVITE_SIGNING_SECRET: randomBytes(32).toString("hex"),
    GITHUB_STATE_SECRET: randomBytes(32).toString("hex"),
    RUNTIME_GATEWAY_SECRET: randomBytes(32).toString("hex"),
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PREFLIGHT_ENABLED: "false",
    AGENT_RUN_ENABLED: "false",
    STRIPE_CHECKOUT_ENABLED: "false",
    ACCESS_CUSTOM_LOGIN_ENABLED: "false",
  };
  writeFileSync(".dev.vars", Object.entries(variables)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n", {
    flag: "wx", mode: 0o600,
  });
  console.log("Created .dev.vars with a loopback identity and local development secrets.");
} else {
  console.log("Preserved existing .dev.vars.");
}

if (!existsSync(localConfig)) {
  config.dev = { ...config.dev, enable_containers: false };
  config.vars = {
    ...config.vars,
    PREFLIGHT_ENABLED: "false",
    AGENT_RUN_ENABLED: "false",
    STRIPE_CHECKOUT_ENABLED: "false",
    ACCESS_CUSTOM_LOGIN_ENABLED: "false",
  };
  writeFileSync(localConfig, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  console.log(`Created ${localConfig} with container builds and external execution disabled.`);
} else {
  console.log(`Preserved existing ${localConfig}.`);
}

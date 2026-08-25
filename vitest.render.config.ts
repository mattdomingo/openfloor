import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./drizzle");

// Fixtures for the /signin render smoke test (tests/render/rendered-html
// .test.ts's "custom sign-in" block). This pool's bindings are fixed for the
// whole suite — unlike tests/worker/access-login.test.ts and
// tests/worker/signin-code-route.test.ts, which import lib/access-login.ts
// and the route handler directly and so can vary these per test case — so
// this only proves the real built app wires the happy path together
// correctly end to end; full branch coverage (flag off, extraction failure,
// SSRF-shaped inputs) lives in those two worker-level files instead.
const RENDER_TEST_TEAM_DOMAIN = "https://openfloor-render-test.cloudflareaccess.com";
const RENDER_TEST_LOGIN_HTML = `<!doctype html><html><body>
  <form class="AuthFormLogin" action='${RENDER_TEST_TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=render-fixture&amp;meta=render-fixture'>
    <input id="email" type="email" name="email">
  </form>
</body></html>`;
const RENDER_TEST_LOGIN_LOCATION =
  `${RENDER_TEST_TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=render-fixture&meta=render-fixture&nonce=render-fixture-nonce`;
// Fixture for resolveOwnStylesheetHref's self-fetch of "/" — a same-origin
// self-request inside this pool's simulated environment produced an
// intermittent "Network connection lost" background error (self-fetch
// itself is confirmed to work in real dev/production, see the 2026-08-25
// decision log's Q1 spike; this is specific to the test pool). Providing the
// fixture makes the render smoke test deterministic and avoids relying on
// that self-fetch path at all.
const RENDER_TEST_LANDING_HTML = '<!doctype html><html><head><link rel="stylesheet" href="/assets/render-fixture.css"></head><body></body></html>';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./dist/server/index.js",
      miniflare: {
        compatibilityDate: "2026-05-22",
        compatibilityFlags: ["nodejs_compat"],
        assets: { directory: "./dist/client", binding: "ASSETS", run_worker_first: true },
        d1Databases: ["DB"],
        durableObjects: { SESSION_PRESENCE: "SessionPresence" },
        bindings: {
          INVITE_SIGNING_SECRET: "render-test-secret",
          OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true",
          CF_ACCESS_TEAM_DOMAIN: "https://openfloor-render-test.cloudflareaccess.com",
          CREDENTIAL_ENCRYPTION_KEY: "render-test-credential-encryption-key",
          OPENFLOOR_TEST_PROVIDER_KEYS: JSON.stringify({
            anthropic: ["sk-ant-render-accepted"],
            openai: ["sk-openai-render-accepted"],
            kimi: ["sk-kimi-render-accepted"],
            gemini: ["AIza-gemini-render-accepted"],
          }),
          ACCESS_CUSTOM_LOGIN_ENABLED: "true",
          OPENFLOOR_TEST_ACCESS_LOGIN_HTML: RENDER_TEST_LOGIN_HTML,
          OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION: RENDER_TEST_LOGIN_LOCATION,
          OPENFLOOR_TEST_LANDING_HTML: RENDER_TEST_LANDING_HTML,
          TEST_MIGRATIONS: JSON.stringify(migrations),
        },
      },
    }),
  ],
  test: { include: ["tests/render/**/*.test.ts"], setupFiles: ["./tests/render/setup.ts"] },
});

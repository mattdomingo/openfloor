# Security Audit and Remediation — 2026-08-30

## Executive summary

This follow-up audit reviewed the latest `origin/main` at `96afa2e1c58f66c43c5a2822c9a693eb2eb993b2`, including authentication and authorization boundaries, webhooks, model gateways, agent runtime cancellation, CI/CD, dependencies, committed-secret exposure, GitHub repository controls, uploads, MCP, and the residual risks from the 2026-08-29 audit.

Three medium-severity findings were remediated. Failed GitHub webhook processing can now be retried with the same delivery ID, cancellation immediately revokes new model-spending requests, and the release workflow validates pull requests and gates production mutation behind a production dependency audit and the complete test pipeline while pinning its supply-chain references.

No production dependency advisory was found. The full development audit still reports four moderate advisories in `drizzle-kit`'s nested legacy `esbuild`; npm's proposed fix is an incompatible downgrade. Production agent execution remains disabled because the prior same-uid `/proc` gateway-token exposure is not resolved by this change.

## Severity model

- **Critical:** direct, broadly exploitable compromise with major confidentiality, integrity, or financial impact.
- **High:** practical privilege, credential, SSRF, privacy-retention, or billing-impact weakness.
- **Medium:** meaningful integrity, spending, supply-chain, or defense-in-depth weakness requiring narrower conditions.
- **Low:** limited-impact hardening or operational hygiene.

## Findings and remediation

### SEC-09 — Failed GitHub webhook processing was permanently deduplicated (Medium, fixed)

**Evidence:** `app/webhooks/github/route.ts` inserted `github_webhook_deliveries` before applying repository, candidate, session, and feedback effects. If any later operation threw, the delivery ID remained present, so a GitHub redelivery was acknowledged as a duplicate and the missing effects could never be retried.

**Fix:** `releaseGitHubWebhookDelivery` deletes the exact delivery claim when processing throws. The route keeps successful claims for replay idempotency and rethrows the original error after releasing a failed claim.

**Functionality impact:** transient webhook failures can be manually redelivered through GitHub. Successful duplicate deliveries remain no-ops.

**Residual risk:** processing can fail after an earlier effect succeeded. Webhook effects must remain replay-safe; current effects are idempotent state assignments, compare-and-set feedback updates, or independently deduplicated queue changes. There is no cross-provider transaction spanning D1, GitHub observation, notifications, and all effects.

**Verification:** D1 integration coverage proves a claimed delivery rejects a duplicate, a released claim can be claimed again, and the successful replay marker remains unique. Existing route tests cover signature rejection, successful processing, and duplicate no-op behavior.

### SEC-10 — Cancellation retained model-spending authority (Medium, fixed)

**Evidence:** OpenAI, Anthropic-compatible, Gemini, Qwen, and DeepSeek gateway handlers accepted both `running` and `cancel_requested`. A valid run token could therefore start additional provider requests after a member pressed Stop and D1 recorded cancellation.

**Fix:** all model gateways require the current run status to be exactly `running` before credential resolution or upstream fetch. Activity streaming and session-context endpoints continue to accept `cancel_requested` so the runner can report and complete bounded shutdown work.

**Functionality impact:** no new model request can begin after cancellation is recorded. A provider request already in flight may still finish because D1 status changes cannot recall bytes already sent upstream.

**Residual risk:** the unresolved same-uid `/proc` weakness could expose a gateway token while agent execution is enabled. Production `AGENT_RUN_ENABLED=false` remains mandatory until a kernel-enforced process boundary passes adversarial testing.

**Verification:** worker coverage changes a live run to `cancel_requested`, exercises OpenAI, Anthropic-compatible, Gemini, and the shared Qwen/DeepSeek chat-compatible gateway, expects `404` from every route, and proves no upstream fetch occurs.

### SEC-11 — Release pipeline mutated production before full validation and used mutable references (Medium, fixed)

**Evidence:** `.github/workflows/deploy.yml` ran only on pushes to `main`, applied remote D1 migrations after `npm ci`, and did not run `npm audit --omit=dev` or `npm test`. Build and deploy followed the migration, so a later failure could leave production schema changed without a validated or deployed application. `actions/checkout@v4`, `actions/setup-node@v4`, and `npm@11` were mutable major-version references.

**Fix:** the workflow runs on pull requests and pushes to `main`; both run `npm audit --omit=dev`, install the lockfile-selected Playwright Chromium build and runner dependencies, and run the complete `npm test` pipeline. Remote migration, production build, and deploy are push-only and occur after those gates. Checkout and setup-node are pinned to reviewed commit SHAs, npm is pinned to `11.19.1`, checkout does not persist credentials, and superseded pull-request runs may cancel while `main` deploys never do.

**Functionality impact:** pull requests now run the full release validation and may take longer. A failed production audit or test prevents remote migration. Production build still runs after migration on `main`, but `npm test` already performs two successful production builds in render and end-to-end stages before mutation.

**Residual risk:** GitHub Actions depends on GitHub-hosted runners, the npm registry, transitive package integrity, and repository administrators. This private repository has no branch protection, rulesets are unavailable on its current plan, Dependabot alerts and code scanning are disabled, and secret-scanning status could not be read, so merge policy remains an operational control.

**Verification:** workflow YAML parses, exact action/npm pins are reviewed, Cloudflare credentials remain scoped only to production mutation steps, and the full local pipeline reproduces the pre-mutation gate.

The newly enforced full-suite gate also exposed three test-environment gaps: the original workflow had never provisioned Playwright Chromium; the long two-user browser test could switch rapidly from Prompts to History before the first contribution request settled; and Wrangler 4.127.1 can fatally lose its local dev-proxy connection on Linux CI, the upstream `workers-sdk#15317` failure. CI now installs Chromium, the test waits for the active contribution request before changing filters, and the browser gate permits one fresh-suite retry only when Wrangler's private debug log contains all four upstream crash signatures. Ordinary failures and a failed retry remain red. None changes product behavior.

## Additional scope conclusions and residual risks

- GitHub repository API inspection found Dependabot alerts disabled, code scanning disabled, no branch protection, and rulesets unavailable under the current private-repository plan. Secret-scanning API access was unavailable. These are operational gaps, not silently treated as passing controls.
- Local `gitleaks`, `trufflehog`, `semgrep`, CodeQL, and `osv-scanner` executables were unavailable. A repository pattern scan found test fixtures and PEM parsing code but no apparent live secret; this is not an independent scanner attestation.
- Public OTP email triggering still needs Cloudflare WAF/rate limiting.
- Uploads retain per-file and count caps but still need product-level aggregate byte and storage quotas.
- Remote MCP validation blocks direct internal targets, but DNS rebinding remains possible and a selected public MCP server receives context.
- Production `AGENT_RUN_ENABLED` must remain false until provider CLIs and repository commands are separated by Linux uid/process namespace or an equivalent kernel boundary and adversarial `/proc`, environment, command-line, and child-process tests pass.
- `npm audit --omit=dev` is clean. Full `npm audit` reports four moderate development-only advisories through `drizzle-kit`'s legacy `esbuild`; the available automated remediation is not compatible with the repository's current tooling.

## Verification record

- Targeted worker tests: passed, 2 files / 90 tests.
- `npm run typecheck`: passed.
- `npm run lint`: passed with two pre-existing `@next/next/no-img-element` warnings.
- `npm run test:unit`: passed, 47 files / 315 tests.
- `npm run test:migrations`: passed, 8 files / 163 tests.
- `npm run test:worker`: passed, 6 files / 84 tests.
- `npm run test:render`: passed, 6 files / 45 tests.
- `npm run build`: passed in both render and end-to-end pipeline stages with the documented future Vite native-config-loader warning.
- End-to-end suite: passed, 11 of 11 tests. Port `8940` avoided unrelated local listeners.
- Workflow YAML parse: passed.
- `npm audit --omit=dev`: passed, zero advisories.
- Full `npm audit`: four moderate development-only advisories under `drizzle-kit`.
- `npm test` with `OPENFLOOR_E2E_PORT=8940`: passed end to end.
- `git diff --check`: passed.

No production state was changed. Merging this pull request to `main` remains the authorization that triggers production deployment.

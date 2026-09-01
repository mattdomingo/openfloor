# Security Audit and Remediation — 2026-08-29

## Executive summary

This audit reviewed authentication, authorization, billing credentials, GitHub installation proof, provider gateways and agent runtimes, MCP, uploads and private R2 storage, WebSockets, webhooks, browser trust boundaries, dependencies, deployment configuration, and committed-secret exposure at `aaf76743039b7dda3f0a920a70e11d360fbd042f` (`origin/main` when the audit began).

Seven security weaknesses were remediated in code and migrations. The audit also found one high-severity runtime isolation weakness that child-environment filtering could not fix: provider CLIs and repository-controlled commands shared a Linux uid, allowing same-uid `/proc` inspection of a CLI's initial gateway token. The 2026-08-31 follow-up implements and adversarially tests a separate-uid boundary in Sandbox image `v9`. Production agent execution remains disabled with `AGENT_RUN_ENABLED = "false"` until that image is deployed and provider acceptance is recorded.

No production dependency advisory remains. Full development audit reports four moderate build-time advisories in `drizzle-kit`'s nested legacy `esbuild`; npm proposes an unsafe downgrade and no compatible upgrade removes them.

## Severity model

- **Critical:** direct, broadly exploitable compromise with major confidentiality, integrity, or financial impact.
- **High:** practical privilege, credential, SSRF, privacy-retention, or billing-impact weakness.
- **Medium:** meaningful defense-in-depth or race weakness requiring narrower conditions.
- **Low:** limited-impact hardening or operational hygiene.

## Findings and remediation

### SEC-01 — Agent billing authority followed a client-selected owner (High, fixed)

**Evidence:** `POST /api/sessions/[id]/agents` accepted a session teammate as `ownerUserId`. `floor_agents.owner_user_id` selects whose provider credential pays for a run, while members could also change billing/model and resume another member's agent. This allowed a collaborator to create or reactivate work billed to a teammate without that teammate's consent.

**Fix:** `app/api/sessions/[id]/agents/route.ts` and `db/floor.ts` now derive/enforce the authenticated creator as owner. Omitted/self `ownerUserId` remains compatible; a teammate ID returns `403`. Collaborative task edits remain available, but model, credential kind, and resume require the recorded agent owner. Pause and Stop remain member safety controls. Owner bulk resume filters by `owner_user_id = caller`. The owner selector was removed, and creation/resume surfaces warn that shared routing and the session owner may invoke the agent and spend its credential. Migration `0042_pale_supernaut.sql` pauses active persistent agents where `created_by <> owner_user_id`.

**Functionality impact:** teammate-owned agent creation ends. Existing mismatched agents remain paused until their recorded owner resumes. Teammates can still edit tasks and pause/stop agents; they cannot change billing/model or resume another member's agent.

**Residual risk:** shared routing and session-owner run controls can intentionally invoke an agent owned by another member. That collaboration model can spend the recorded owner's credential; UI disclosure and owner-only resume are the consent boundary.

**Verification:** worker authorization matrices cover self/teammate creation, collaborative task edits, owner-only settings/resume, member Pause/Stop, owner-scoped bulk resume, auto-dispatch billing, and exact migration replay.

### SEC-02 — Provider CLI gateway tokens are same-uid observable (High, fixed in image `v9`; rollout pending)

**Evidence:** Codex, Gemini, Qwen, built-in MCP, and repository-controlled child processes were traced through `worker/agent-run-workflow.ts`, runner scripts, container users, environment variables, command lines, and Linux process semantics. Child environment filtering prevents ordinary inheritance, but deleting or overwriting `process.env` does not remove the process's initial environment from `/proc/<pid>/environ`. Provider CLI and repository commands run as `openfloor-agent`, so same-uid inspection remains possible.

**Fix:** Sandbox image `v9` gives token-bearing provider CLIs uid `openfloor-provider`, trusted srt setup the credential-free uid `openfloor-broker`, and model-selected commands uid `openfloor-workspace`. A root-owned setuid launcher clears the child environment and supplementary groups. Its guarded bubblewrap seam rejects workspace callers and caller-selected identity, capability, or user-namespace options; validates srt's fixed network/PID/proc and capability-drop policy; maps bubblewrap's outer real uid/gid to the workspace identity; and starts an outer fixed filesystem/network/PID sandbox through bubblewrap's native setuid path. A minimal inner bubblewrap grants namespace-scoped setup capability only to the validated pinned `apply-seccomp` command chain; `apply-seccomp` clears it and sets `no_new_privs` before model-selected code. Codex uses the fixed-policy launcher as its shell, Claude uses the guarded bubblewrap seam, and Gemini/Qwen route every supported `node:child_process` API through the fixed-policy launcher. Provider and workspace homes are separate mode-`0700` directories; only their shared repository group permits normal edits. The broker has neither that group nor provider credentials. The built-in MCP process stays provider-side with only its explicit bounded tokens. The earlier safe-environment controls remain as defense in depth.

**Functionality impact:** no intended run behavior changes after rollout. All production agent runs remain unavailable while the global gate is false, regardless of provider-specific gates. Preflight remains independently gated.

**Residual risk/inherent risk:** enabling agent execution remains inherently risky: repository code and model-directed commands execute in ephemeral containers. The workspace identity intentionally retains repository write access but has no network access or access to provider homes. Image deployment and disposable-repository acceptance for every enabled provider remain required before a separately authorized gate change.

**Verification:** unit probes cover every wrapped synchronous/asynchronous child-process family, overload and option preservation, safe `PATH`/`HOME`, exact built-in MCP matching, expanded provider-secret examples, and the provider-specific launcher seams. CI builds the real image and runs an adversarial Linux test covering identity, inherited environment, provider `/proc` environment/memory/file descriptors, process command lines, provider-home access, Codex shell execution, and Claude bubblewrap execution. The production hold stays closed independently of test success.

### SEC-03 — D1 deletion left private R2 artifacts behind (High, fixed)

**Evidence:** session/account/retention deletion cascaded D1 rows but did not durably delete `sessions/<id>/`, `runs/<id>/`, `preflights/<id>/`, `conflicts/<id>/`, or account-avatar objects. R2 has no transaction with D1, and delayed Workflow writes could recreate data after a one-shot deletion.

**Fix:** migrations `0042`/`0043` add `storage_cleanup_prefixes`. `db/storage-cleanup.ts` derives internal-ID prefixes and enqueues them before session deletion, account scrubbing, or the 30-day retention purge. Retention selects at most 25 sessions per invocation. Scheduled cleanup processes 25 jobs per sweep, lists up to 10,000 objects per job, deletes in 1,000-key batches, retries failures independently, and pushes a live-source job's due time forward so a full window cannot starve later work. A first empty scan starts a 24-hour hold; only a second empty confirmation removes the durable intent.

**Functionality impact:** deleted session/account artifacts become unrecoverable after cleanup. Cleanup is asynchronous and may take more than 24 hours by design.

**Residual risk:** objects written under an unrecorded or nonstandard key are outside prefix cleanup. Future R2 writers must use documented internal-ID prefixes and add their prefix to `sessionPrefixes`.

**Verification:** worker tests cover queued prefixes for manual session deletion, account deletion, bounded retention purge, paginated object deletion, delayed empty confirmation, durable retry behavior, and a full 25-row live-source starvation window.

### SEC-04 — Remote MCP accepted SSRF-prone endpoints (High, fixed with residual DNS risk)

**Evidence:** MCP validation required HTTPS but allowed arbitrary ports, URL credentials, local/internal names, and non-global literal IPs. Existing stored rows were not revalidated at run assembly.

**Fix:** `lib/mcp-config.ts` requires HTTPS on port 443, rejects userinfo and localhost/`.localhost`/`.local`/`.internal`, and uses exact `ipaddr.js@2.5.0` parsing to normalize and reject literal non-global IPv4/IPv6 forms. `db/mcp-servers.ts` revalidates enabled rows at dispatch so legacy unsafe entries fail closed.

**Functionality impact:** nonstandard-port and internal MCP servers stop working.

**Residual risk/inherent risk:** DNS rebinding is not prevented because hostname resolution occurs later in the container. A malicious public MCP server receives selected context and can return hostile instructions. Strict environments should disable remote MCP.

**Verification:** worker tests cover allowed public HTTPS, blocked URL credentials/ports/internal names/alternate literals, encrypted headers, and runtime rejection of legacy unsafe rows.

### SEC-05 — GitHub installation ID was stored before repository-scope proof (Medium, fixed)

**Evidence:** the installation callback fetched account metadata and could persist an association without proving a nonempty repository scope. Installation IDs are not secrets or proof of user authority. Legacy null/empty scope rows could satisfy connection checks.

**Fix:** OAuth/device verification must return a nonempty repository-ID scope before metadata lookup or association upsert. Missing-code, failed-proof, and empty-scope callbacks consume signed state once but create no association. Active/list/repository-selection reads require valid nonempty JSON scope; legacy empty rows remain only as inactive audit data.

**Functionality impact:** failed or empty GitHub installation callbacks no longer appear connected and may require the user to retry verification.

**Residual risk:** GitHub remains authoritative for later repository access; every selection still re-reads access server-side.

**Verification:** worker callback/device tests cover missing code, proof failure, empty scope, single-use state, delayed metadata lookup, verified success, and legacy empty-scope exclusion.

### SEC-06 — Browser mutation and response hardening were decentralized (Medium, fixed)

**Evidence:** unsafe API requests did not have a central Fetch Metadata/Origin check, and security/cache headers depended on individual routes.

**Fix:** `worker/index.ts` applies `lib/http-security.ts` before application routing. Unsafe `/api/*` methods reject `Sec-Fetch-Site: cross-site` or mismatched `Origin`; absent headers remain valid for trusted non-browser clients/tests. Responses receive `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, minimal CSP, strict-origin referrer policy, disabled camera/microphone/geolocation, and HSTS on non-loopback HTTPS. API/runtime/auth responses without explicit cache policy receive `no-store`; static, avatar, authorized-file, and image policies remain authoritative.

**Functionality impact:** iframe embedding is blocked. Cross-site browser mutation clients must move to same-origin requests. Headerless trusted clients continue to work.

**Residual risk:** absent browser headers are deliberately accepted for non-browser compatibility; authentication and authorization remain mandatory. Cloudflare Access and public OTP abuse controls are external operational boundaries.

**Verification:** unit tests cover same-origin/cross-site/missing-header decisions, header values, HSTS, no-store, explicit cache preservation, and WebSocket handling.

### SEC-07 — Equal-millisecond ChatGPT refreshes could win out of order (Medium, fixed)

**Evidence:** the credential refresh compare-and-set used `updated_at` as a version, but a refresh timestamp equal to the stored value was not strictly newer. Concurrent refreshes resolving in one millisecond could lose deterministic ordering.

**Fix:** `db/provider-credentials.ts` writes `Math.max(now, resolved.updatedAt + 1)`. The conditional update now always advances the version.

**Functionality impact:** none.

**Residual risk:** upstream refresh failure still refuses the run; it never falls back to a different payer.

**Verification:** deterministic concurrent-refresh coverage fixes `now` to the same millisecond and proves only the newest bundle persists.

### SEC-08 — Dependency and image provenance drift (Medium, partially fixed/accepted)

**Evidence:** older Cloudflare/Vite tooling and Sandbox `undici` carried avoidable advisory/provenance exposure; the Sandbox base used a mutable tag. `drizzle-kit` retains nested legacy `esbuild` advisories.

**Fix:** upgraded and exactly pinned `@cloudflare/vite-plugin` to `1.54.2`, Wrangler to `4.127.1`, Vite to `8.2.2`, `@cloudflare/workers-types` to `5.20260830.1`, `vinext` to `1.0.0-beta.8`, and `@vitejs/plugin-rsc` to `0.5.34`. The vinext/RSC pair passed typecheck and production build together. Sandbox `undici` is `7.29.0`; the `cloudflare/sandbox:0.12.7` base is pinned by digest.

**Functionality impact:** no intended application behavior change. Vite emits a future native config-loader warning about JSON import attributes/extensions; build succeeds.

**Residual risk:** full audit reports four moderate build-time advisories under `drizzle-kit`; npm's suggested `drizzle-kit@0.18.1` downgrade is incompatible and unsafe. Production audit is clean.

**Verification:** `npm audit --omit=dev` reports zero advisories; full `npm audit` reports exactly four moderate advisories in the documented development-only chain; typecheck and production build pass.

## Additional scope conclusions

- Cloudflare Access JWT verification and trusted-header stripping remain defense in depth. WebSocket upgrades still authenticate and verify D1 membership before Durable Object handoff.
- GitHub and Stripe webhook routes remain intentionally public, with bounded raw bodies and provider signature verification as their authentication boundary.
- Upload serving retains `nosniff` and attachment-only treatment for non-images. Per-file/count caps exist, but product-level aggregate byte/storage quotas remain an unresolved abuse control.
- Public OTP email triggering needs a Cloudflare WAF/rate-limit policy; this is operational work outside the repository.
- Secret-pattern review found only test fixtures and PEM parsing code, not a committed live secret. `gitleaks`, `semgrep`, and `trivy` were unavailable, so this was not an independent scanner attestation.

## Verification record

- `npm run typecheck`: passed.
- `npm run lint`: passed with two pre-existing `@next/next/no-img-element` warnings.
- `npm test` with `OPENFLOOR_E2E_PORT=8933`: passed end to end.
- `npm run test:unit`: passed, 47 files / 315 tests.
- `npm run test:migrations`: passed, 8 files / 163 tests, including exact `0042` quarantine replay and bounded retention purge.
- `npm run test:worker`: passed, 6 files / 83 tests, including full-window cleanup starvation coverage.
- `npm run test:render`: passed, 6 files / 45 tests.
- `npm run build`: passed with the documented future config-loader warning.
- `npm audit --omit=dev`: passed, zero advisories.
- Full `npm audit`: four moderate development-only advisories under `drizzle-kit`.
- `git diff --check`: passed.
- Sandbox image build: blocked locally because Docker Desktop daemon was unavailable. Production execution remains disabled, so no unverified image is authorized for runs.
- End-to-end suite: passed, 11 of 11 tests. Port `8933` avoids the unrelated standing process on default port `8787`.

## Required operational follow-up before enabling agent execution

1. Split provider CLI and repository-controlled commands across Linux uids or another kernel-enforced process boundary.
2. Build the pinned amd64 Sandbox image in a working Docker environment.
3. Run adversarial probes for every provider and built-in MCP across environment variables, child process environments, command lines, and `/proc`.
4. Keep each affected provider gate disabled if its isolation test fails; keep the global gate disabled if OpenAI/Codex isolation fails.
5. Apply Cloudflare WAF/rate limiting to public OTP email triggering and define aggregate upload/storage quotas separately.

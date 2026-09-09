# Known Limitations and Footguns

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size threshold. This is the authoritative source for the full list of known limitations, sharp edges, and footguns — keep it factually correct the same way `CLAUDE.md` itself must stay correct (update it in the same change as any behavior it describes).

---

- The database provider-identity column is still named `chatgpt_user_id`; it is not ChatGPT-specific anymore.
- `BASE_PATH` is `""` in every environment (the app owns `app.opnflr.com` outright); it's kept wired through rather than deleted in case a path prefix is needed again later.
- Next `Link` and manual `fetch` have different base-path responsibilities, even though `BASE_PATH` is currently empty.
- Cloudflare Access configuration is external state; code passing locally does not prove the production policy paths are correct. The hosted login screen's branding is dashboard-applied too — steps in `docs/cloudflare-access-branding.md`.
- The Worker claims `app.opnflr.com` via a `custom_domain: true` route in `wrangler.jsonc`, which has Cloudflare manage the DNS record.
- Access protects `/auth/complete` and `/api/*` at the edge. Real pages sit outside Access and depend on the Worker verifying the signed `CF_Authorization` cookie; do not remove that trust boundary.
- `/webhooks/github` is deliberately public and must never process a payload before its raw-body HMAC and size are verified.
- `/webhooks/stripe` is deliberately public and must never process a payload before its 256 KB limit and raw-body Stripe signature are verified. Cloudflare Access must not protect it.
- Stripe Portal behavior is dashboard state: the configured Portal must allow only the two exact monthly prices and their seat quantities, prorate changes immediately, and cancel immediately. A permissive Portal configuration weakens application-side validation.
- Candidate naming never accepts a complete Git ref. Contents write creates only the server-generated `openfloor/<session-short>/candidate/<safe-name>-<candidate-short>` ref; no generic branch CRUD, force push, base write, protection change, or arbitrary deletion is exposed.
- Phase 3 source checkout proxies an exact GitHub archive through `/runtime/preflight/source`; the Sandbox receives only a short-lived source-only JWT, never the GitHub installation token.
- `@cloudflare/sandbox` and the digest-pinned `cloudflare/sandbox` image are pinned together at `0.12.7`. Docker must be running for local development and deploys that build the container image.
- The production preflight gate remains disabled because owner-configured check commands were removed this release. Its historical data and runtime stay present for a later redesign; do not expose **Verify runner** without a real command source.
- Preflight output is bounded before R2 persistence and combined log responses are capped; large logs and secrets must never be written to D1.
- Global agent execution is enabled for admitted production beta testers and for the developer-restricted development environment after image `v9` deployed with its adversarially tested provider/workspace uid boundary. Development has no shared fallback provider keys by default, so testers connect their own credentials. Production and development acceptance remain monitored rollouts. GLM, Qwen, and DeepSeek remain unavailable until their independent live-key acceptance passes; setting the target environment's `AGENT_RUN_ENABLED=false` is the global rollback for that environment.
- Agent execution is inherently risky even after that gate is resolved: repository code and model-directed commands execute in containers with selected network access. Isolation reduces blast radius; it does not make untrusted code safe.
- Repository preview is available only on the developer-restricted development deployment; production remains disabled pending its own wildcard DNS/TLS, separate preview Access application and audience, migration deployment, and acceptance run. Preview v1 supports only one root JavaScript app with exactly one npm, pnpm, Yarn, or Bun lockfile and a `dev` or `start` script. Install and runtime use the same credential-free namespace as agent runs. It does not support monorepos, multiple services, custom commands, secrets, runtime environment configuration, outbound runtime APIs, or non-JavaScript applications.
- Remote MCP is inherently risky. Configured servers receive selected run context and may return hostile instructions. URL validation blocks credentials, non-443 ports, internal names, and non-global literal IPs, but DNS rebinding and malicious public servers remain residual risks. Strict environments should disable remote MCP.
- Public OTP email triggering still needs Cloudflare WAF/rate-limit policy. Application code alone cannot prevent distributed abuse of the public Access email-code surface.
- Session uploads have per-request file/count limits but no product-level aggregate byte or storage quota. Current caps are not a complete abuse-control system.
- API mutation CSRF protection deliberately permits absent `Origin`/Fetch Metadata for trusted non-browser clients and tests. Browser integrations must be same-origin; iframe embedding is blocked by response policy.
- Full `npm audit` still reports four moderate advisories in `drizzle-kit`'s legacy nested `esbuild`. No compatible `drizzle-kit` upgrade removes them; npm's proposed `0.18.1` downgrade is unsafe. This is a build-time residual risk, not a production dependency (`npm audit --omit=dev` is clean).
- Set `GITHUB_APP_PRIVATE_KEY` by piping the complete downloaded PEM file into `wrangler secret put`; an App installation redirect can succeed even when this key is malformed, but repository discovery cannot. The GitHub client accepts both GitHub's PKCS#1 `RSA PRIVATE KEY` download and PKCS#8 `PRIVATE KEY` PEM formats.
- Floor snapshots are caller-specific because of DM filtering.
- Realtime `floor.changed` is a refetch signal, not the changed records themselves.
- Draft Hidden mode does not stop outbound sharing.
- Agent names may contain spaces, while the current `@mention` helper recognizes a single word-like name. Explicit target selection is the reliable path for multiword agent names until mention parsing is redesigned.
- Owners cannot leave because ownership transfer is deferred.
- Review is derived from the latest active or merged candidate, its bounded GitHub PR snapshot, and retained real run attribution; complete artifacts remain outside the snapshot.
- PR feedback nudges carry no CI log tails (that needs an Actions:read App permission every installer would re-accept) and name one responsible agent per nudge; the GitHub App must subscribe to `pull_request_review` and `pull_request_review_comment` or those nudges never fire.
- Thread resume covers the Codex, Claude, and Qwen Code runners (`resumableProvider`); Gemini runs always start fresh. A resume needs the prior attempt's `session_store` artifact, which is capped at 8 MB compressed — an oversized transcript logs a `session_store_skipped` event and the next attempt starts fresh.
- Browser conflict alerts require an open hidden floor tab, explicit per-device opt-in, and browser permission. Web Locks plus a localStorage receipt suppress duplicate multi-tab alerts. There is no closed-app push, email, or third-party delivery.
- The UI contains restored visual affordances from a prototype; verify backend wiring before claiming any action is real.
- Wrangler is pinned. A newer compatibility date may be rejected until Wrangler is upgraded deliberately.
- This `AGENTS.md` is the comprehensive context source; keep shorter README and focused docs consistent with it.

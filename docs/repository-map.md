# Repository Map

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size threshold. This is the authoritative source for the annotated repository directory tree — keep it factually correct the same way `CLAUDE.md` itself must stay correct (update it in the same change as any behavior it describes).

---

```text
app/                         Next App Router pages and API route handlers
  access-auth.ts             Reads trusted Worker-provided identity
  api/                       Authenticated application interfaces
  home/                      Member session list and creation
  join/                      Authenticated invite preview and acceptance
  session/                   Lobby and Agent Floor routes
  styles/                    Tokens, layout, product, and restored floor styles
components/product/          Page-level product screens
  RepositoryCard.tsx         Member-visible repository state and owner-only GitHub setup controls
components/session/          Agent Floor workspace components and client data source
db/
  schema.ts                  Drizzle schema source
  sessions.ts                Prepared D1 user/session/member/invite queries
  billing.ts                 Stripe customer/subscription/event persistence and entitlement projection
  provider-credentials.ts    Encrypted per-user provider credential rows and owner resolution
  skills.ts                  Owner-gated session skill imports and run materialization reads
  mcp-servers.ts             Owner-gated MCP server config with encrypted headers and run reads
  floor.ts                   Prepared D1 floor snapshot and mutation queries
  conflicts.ts               Durable conflict cases, resolver attempts/questions, transitions, and review reads
  repositories.ts            Owner-gated GitHub connection and check-command persistence
  preflights.ts              Durable preflight/check state and internal Workflow transitions
  runs.ts                    Durable agent-run lifecycle, checks, files, artifacts, thread resume, and execution context
  candidate-feedback.ts      PR feedback nudge context, responsible-agent lookup, and compare-and-set queue writes
  rollbacks.ts               Authorized durable rollback attempts and candidate lease transitions
  session-context.ts         Session-scoped, member-neutral floor read for the agent brief (D1)
drizzle/                     Generated D1 migrations and metadata
lib/
  floor-types.ts             Public persisted floor types
  session-types.ts           Session, identity, presence, and typing event types
  session-context.ts         Pure session-brief renderer (no D1); shared by dispatch and live re-read
  conflict-resolver-prompt.ts Pure specialized resolver prompt renderer
  run-resume.ts              Pure provider-thread resume eligibility (which earlier run a new attempt may continue)
  pr-feedback.ts             Pure PR feedback nudge messages, signatures, and dedup planning
  candidate-feedback.ts      Webhook-driven PR feedback re-observation and nudge queueing
  conflict-notifications.ts  Device-local attention event and multi-tab browser-alert claim helpers
  validation.ts              Bounded input parsing and normalization
  identity.ts                Access verification and local identity isolation
  invites.ts                 HMAC signing and constant-time verification
  stripe.ts                  Stripe client, bindings, and webhook signature verification
  stripe-billing.ts          Checkout, Portal, reconciliation, and account-cancellation orchestration
  credential-crypto.ts       AES-GCM encryption at rest for provider credentials
  provider-credentials.ts    Pure provider/credential types, per-provider default models, run resolution order
  provider-validation.ts     Connect-time key validation against provider models endpoints
  claude-sandbox-settings.ts Pinned Claude-runner sandbox posture serializer
  gemini-settings.ts         Pinned Gemini CLI system-scope settings and the shared srt posture serializer
  qwen-settings.ts           Pinned Qwen Code CLI system-scope settings (qwen + deepseek runs)
  openai-chat-compat-gateway.ts  Shared chat-completions gateway handler (qwen, deepseek routes)
  anthropic-compat-gateway.ts    Shared Anthropic-Messages gateway handler (anthropic, kimi, glm routes)
  skill-validation.ts        Bounded SKILL.md frontmatter parsing and slug rules
  mcp-config.ts              Provider-neutral MCP server types, bounds, and per-provider serialization
  github.ts                  GitHub App JWT, installation-token, repository, and branch reads
  github-state.ts            Signed callback state and webhook HMAC verification
  runtime-token.ts           Short-lived preflight/run operation-scoped gateway JWTs
  presence-server.ts         Internal application-to-Durable-Object notifications
  floor-api.ts               Shared floor route response helpers
  floor-state.ts             Pure queue/mention/revision/objective-nudge client helpers
  typing-drafts.ts           Pure live-draft reducers and visibility selection
worker/
  index.ts                   Cloudflare entry, identity boundary, assets, app dispatch
  presence.ts                Authenticated WebSocket route and SessionPresence object
  preflight-workflow.ts      Durable exact-source Sandbox preflight orchestration
  agent-run-workflow.ts      Durable Codex/check/cancellation Sandbox orchestration
Dockerfile.sandbox           Version-matched Cloudflare Sandbox runtime image
.github/workflows/deploy.yml Push-to-main production deploy (test → migrate → build → deploy)
scripts/codex-runner.mjs     Pinned server-side Codex SDK runner inside the Sandbox image
scripts/claude-runner.mjs    Pinned Claude Agent SDK runner (non-root, kernel-sandboxed) in the same image
scripts/gemini-runner.mjs    Pinned Gemini CLI runner (non-root, srt-wrapped) in the same image
scripts/gemini-proxy-preload.mjs  Fetch preload making the Gemini CLI honor srt's proxy env on Node 22
scripts/qwen-runner.mjs      Pinned Qwen Code CLI runner (non-root, srt-wrapped) serving qwen and deepseek in the same image
scripts/openfloor-mcp.mjs    Stdio MCP server exposing read-only session context and run-scoped conflict input
scripts/publish-bundle.mjs   Fixed trusted bundle/ref/ancestry/file/object validation and non-force publication
tests/
  unit/                      Pure functions, validation, identity, signing, reducers
  worker/                    Local D1 and Durable Object integration tests
  render/                    Built Worker/server-rendering and route behavior
  e2e/                       Two authenticated browser-context product flow
docs/agent-backend-gaps.md   Deferred execution/repository capabilities
docs/cloudflare-access-branding.md  Manual Zero Trust login/App Launcher branding steps
docs/github-production.md    Production GitHub App, Access, secrets, migration, and deploy runbook
wrangler.jsonc               Production bindings, routes, migrations, compatibility
```

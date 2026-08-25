# Agent backend gaps

The current backend persists collaboration state, repository/candidate state, preflight history, agent runs, and final review/merge audit state. Candidate name and description default from the session title/objective, remain durable, produce a safely slugged server-owned ref, and title/describe the draft pull request. An owner can start or cancel Codex against the exact candidate SHA. Every passing run is bundle-validated, published independently, and then integrated serially into the active candidate. The first integration creates one draft pull request; later runs update that same candidate/PR. Conflicts remain blocked and owner retry creates a new attempt from the latest candidate. GitHub remains authoritative for PR head/base, files, checks, readiness, mergeability, protection enforcement, squash merge confirmation, and branch heads used for safe cleanup.

The Claude-provider milestone (per-user encrypted credentials, the Claude runner with its verified sandbox posture, provider selection, session-scoped imported skills, and owner-configured remote MCP servers) is live behind `CLAUDE_RUN_ENABLED=true`; see AGENTS.md's 2026-08-21 decision-log entries. Kimi (Moonshot, same runner via `/runtime/kimi`) and Gemini (own CLI runner) are live behind `KIMI_RUN_ENABLED=true`/`GEMINI_RUN_ENABLED=true`; Grok (xAI) is deliberately excluded — its Anthropic compat rejects the CLI's system-role messages (2026-08-24 decision-log entry). Still deferred: per-agent model selection, `stdio` MCP transports for user-configured servers, the Codex and Gemini serializers for user-configured MCP servers, skills for non-Claude-runner providers, claude.ai skill sync, and token/cost metering (runners capture `usage` into result.json; `parseCodexResult` discards it).

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Per-agent **model** selection in the agent-creation UI, and agent-authored chat messages. (Provider selection is implemented: the dialog offers every provider whose rollout flag is on. User-managed provider credentials are implemented — per-user encrypted keys in `user_provider_credentials`, resolved per run as agent-owner-key-else-server-key. See AGENTS.md's 2026-08-21 and 2026-08-24 decision-log entries.)
- Deployment and generic support for merge queues or non-squash merge methods.
- Generic artifact download UI beyond the per-run raw-log and session-brief expanders.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

Repository connection, active candidate/PR identity, bounded latest-preflight data, and the latest 20 caller-visible run summaries are included in `FloorSnapshot`; full logs and bundles remain excluded. Run branches, publication/integration SHAs, conflicts, and independent attribution stay visible.

## Live run activity streaming

Runs stream a bounded activity feed while Codex executes. The in-sandbox runner (`scripts/codex-runner.mjs`) normalizes Codex thread events (reasoning, commands, file edits, agent messages, MCP tool calls, errors) and POSTs batches to `POST /runtime/run/events`, authenticated by a run-scoped gateway token with the `events` operation and gated on run status `running`/`cancel_requested`. Events persist in `agent_run_events` with runner sequences starting at 1,000,000; coarse workflow-stage events keep the per-run `MAX+1` scheme, so the merged timeline stays chronological under `ORDER BY sequence`. Accepted events broadcast to session members as a `run.activity` presence event without bumping `floor_revision`; members catch up or paint initial state via `GET /api/sessions/:id/runs/:runId/events?after=<sequence>`. Bounds: detail ≤ 2,000 chars, ≤ 50 events and 256 KB per POST, ≤ 2,000 runner events per run with a `truncated` sentinel; telemetry failures never fail the run.

## Session context and the live re-read tool

Every dispatched agent's prompt is a unified session brief (`db/session-context.ts` + `lib/session-context.ts`): its own request, every other agent and human on the floor, already-integrated work, other runs in flight with their live file edits, the rest of the queue, blocked/failed runs, and recent public team chat — bounded to 24,000 characters, direct messages structurally excluded (the D1 read never takes a `userId`). The exact rendered prompt is persisted as an `agent_run_artifacts` row of kind `prompt` and visible via a second Agent-card expander. A long run can re-read current floor state through a read-only `openfloor_session_context` MCP tool exposed by the Sandbox (`scripts/openfloor-mcp.mjs`), backed by `GET /runtime/run/context` (a `"context"`-operation gateway token, 60-minute TTL). Pooled run sandboxes are keyed by `RUN_SANDBOX_IMAGE_VERSION` so a stale pooled container can never be claimed by a live run after a `Dockerfile.sandbox` change — bump that constant whenever the image's contents change.

## Credential kinds — deliberately deferred pieces

Per-user credentials are keyed `(user_id, provider, kind)` with kinds `api_key` and `oauth` (pasted Claude setup token / ChatGPT auth bundle), and each agent's `credential_kind` names which one its runs bill. Deliberately not built: gateway-native handling of `oauth` upstream auth (the standing brief's §4/§5, gated on their spikes — until then a subscription-bound run fails honestly at the vendor); more than one row per user+provider+kind (raising the ceiling later means a nickname column and a picker, not another recreate); automatic failover between a member's own two credentials on a rate-limit response (rejected: it switches billing ledgers mid-run); showing a member their remaining subscription quota or another member's connection status (no authoritative source; not the creator's to see).

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply DB --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test the owner/member flow from `docs/github-production.md` against only the disposable acceptance repository, including two consecutive integrations into one draft PR, conflict preservation, retry as a new attempt, ready-for-review, protected squash merge, exact-SHA cleanup, a fresh candidate cycle, reload recovery, cancellation, and a failing retryable run.

Known follow-up: Phase 5 discard is still reported by the production UI as unsuccessful in the acceptance repository after the authentication correction. Keep its expected-SHA safety checks intact and diagnose it in the separately requested ticket; it is not part of Phase 6 acceptance.

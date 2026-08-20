# Agent backend gaps

The current backend persists collaboration state, repository/candidate state, preflight history, agent runs, and final review/merge audit state. Candidate name and description default from the session title/objective, remain durable, produce a safely slugged server-owned ref, and title/describe the draft pull request. An owner can start or cancel Codex against the exact candidate SHA. Every passing run is bundle-validated, published independently, and then integrated serially into the active candidate. The first integration creates one draft pull request; later runs update that same candidate/PR. Conflicts remain blocked and owner retry creates a new attempt from the latest candidate. GitHub remains authoritative for PR head/base, files, checks, readiness, mergeability, protection enforcement, squash merge confirmation, and branch heads used for safe cleanup.

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Model/provider discovery, user-managed credentials, and agent-authored chat messages.
- Deployment and generic support for merge queues or non-squash merge methods.
- Generic artifact download UI beyond the per-run raw-log expander.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

Repository connection, active candidate/PR identity, bounded latest-preflight data, and the latest 20 caller-visible run summaries are included in `FloorSnapshot`; full logs and bundles remain excluded. Run branches, publication/integration SHAs, conflicts, and independent attribution stay visible.

## Live run activity streaming

Runs stream a bounded activity feed while Codex executes. The in-sandbox runner (`scripts/codex-runner.mjs`) normalizes Codex thread events (reasoning, commands, file edits, agent messages, errors) and POSTs batches to `POST /runtime/run/events`, authenticated by a run-scoped gateway token with the `events` operation and gated on run status `running`/`cancel_requested`. Events persist in `agent_run_events` with runner sequences starting at 1,000,000; coarse workflow-stage events keep the per-run `MAX+1` scheme, so the merged timeline stays chronological under `ORDER BY sequence`. Accepted events broadcast to session members as a `run.activity` presence event without bumping `floor_revision`; members catch up or paint initial state via `GET /api/sessions/:id/runs/:runId/events?after=<sequence>`. Bounds: detail ≤ 2,000 chars, ≤ 50 events and 256 KB per POST, ≤ 2,000 runner events per run with a `truncated` sentinel; telemetry failures never fail the run.

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply DB --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test the owner/member flow from `docs/github-production.md` against only the disposable acceptance repository, including two consecutive integrations into one draft PR, conflict preservation, retry as a new attempt, ready-for-review, protected squash merge, exact-SHA cleanup, a fresh candidate cycle, reload recovery, cancellation, and a failing retryable run.

Known follow-up: Phase 5 discard is still reported by the production UI as unsuccessful in the acceptance repository after the authentication correction. Keep its expected-SHA safety checks intact and diagnose it in the separately requested ticket; it is not part of Phase 6 acceptance.

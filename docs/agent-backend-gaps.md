# Agent backend gaps

The current backend persists collaboration state, repository/candidate state, preflight history, and Phase 6 agent runs. An owner can start or cancel Codex against the exact candidate SHA. Every passing run is bundle-validated, published independently, and then integrated serially into the active candidate. The first integration creates one draft pull request; later runs update that same candidate/PR. Conflicts remain blocked and owner retry creates a new attempt from the latest candidate.

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Model/provider discovery, user-managed credentials, and agent-authored chat messages.
- Pull-request readiness, protection/check reconciliation, final squash merge, branch cleanup, and deployment.
- Live terminal streaming and generic artifact download UI.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

Repository connection, active candidate/PR identity, bounded latest-preflight data, and the latest 20 caller-visible run summaries are included in `FloorSnapshot`; full logs and bundles remain excluded. Run branches, publication/integration SHAs, conflicts, and independent attribution stay visible.

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply DB --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test the owner/member flow from `docs/github-production.md` against only the disposable acceptance repository, including two consecutive integrations into one draft PR, conflict preservation, retry as a new attempt, reload recovery, cancellation, and a failing retryable run.

Known follow-up: Phase 5 discard is still reported by the production UI as unsuccessful in the acceptance repository after the authentication correction. Keep its expected-SHA safety checks intact and diagnose it in the separately requested ticket; it is not part of Phase 6 acceptance.

# Agent backend gaps

The current backend persists collaboration state, repository/candidate state, preflight history, and Phase 4 agent runs. An owner can start or cancel Codex against the exact candidate SHA through a durable Cloudflare Workflow and isolated Sandbox. Passing local changes and required checks populate real Agent and Review data; they are not pushed to GitHub. D1 stores bounded run/check/file summaries, while private R2 stores bounded logs and diffs. Operation-scoped gateways keep GitHub installation and OpenAI project credentials outside repository processes.

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Model/provider discovery, user-managed credentials, and agent-authored chat messages.
- Git bundle export/validation, run branches, publication, and safe discard.
- Candidate integration, conflicts/rebase attempts, pull requests, approval persistence, merge, and deployment.
- Live terminal streaming and generic artifact download UI.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

Repository connection, active candidate, bounded latest-preflight data, and the latest 20 caller-visible run summaries are included in `FloorSnapshot`; full logs and future bundles remain excluded. Run mutations increment the floor revision and broadcast `queue`, `runs`, and `review` invalidations. `review` remains null until a genuine run records changed files. Phase 5 must publish through a trusted bundle-validation boundary without giving the Sandbox GitHub write credentials.

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply DB --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test the owner/member flow from `docs/github-production.md` against only the disposable acceptance repository, including a passing run, changed-file Review, reload recovery, a cancelled run, and a failing retryable run.

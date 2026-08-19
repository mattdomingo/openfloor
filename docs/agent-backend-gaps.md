# Agent backend gaps

The current backend persists collaboration state, repository/candidate state, preflight history, and Phase 5 agent runs. An owner can start or cancel Codex against the exact candidate SHA. Every passing run is bundle-validated in a clean publisher Sandbox, pushed without force to its own server-generated GitHub branch, and reconciled by SHA. Consecutive prompts therefore retain independent changes and attribution. D1 stores bounded run/check/file/publication summaries, while private R2 stores bounded logs, diffs, and bundles. Repository processes receive neither GitHub installation nor OpenAI project credentials.

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Model/provider discovery, user-managed credentials, and agent-authored chat messages.
- Candidate integration, conflicts/rebase attempts, pull requests, approval persistence, merge, and deployment.
- Live terminal streaming and generic artifact download UI.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

Repository connection, active candidate, bounded latest-preflight data, and the latest 20 caller-visible run summaries are included in `FloorSnapshot`; full logs and bundles remain excluded. Run branches and publication/discard SHAs are visible, while `review` remains null until a genuine run records changed files. Phase 6 must integrate published runs into the candidate serially without force and preserve independent run history.

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply DB --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test the owner/member flow from `docs/github-production.md` against only the disposable acceptance repository, including two consecutive published run branches, changed-file Review, reload recovery, safe discard, external-mutation refusal, cancellation, and a failing retryable run.

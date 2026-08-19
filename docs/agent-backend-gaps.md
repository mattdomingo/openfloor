# Agent backend gaps

The current backend persists collaboration state, the repository candidate, and Phase 3 preflight history. An owner can run ordered required checks against the exact candidate SHA through a durable Cloudflare Workflow and isolated Sandbox. D1 stores bounded status/check summaries; private R2 stores bounded real output. Source is fetched through a short-lived, operation-scoped Worker gateway, so GitHub installation credentials stay outside repository processes. No agent code generation, run branch, commit, pull request, merge, or deletion exists yet.

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Model/provider discovery, agent execution, cancellation, and retry.
- Repository checkout, worktrees, run branches, file scopes, attachments, and code modification.
- Agent runtime progress, current steps, agent-generated messages, status transitions, and queue consumption.
- Agent-run changed files, diffs, conflicts, review candidates, approval persistence, merge, and deployment.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

Repository connection, active candidate, and bounded latest-preflight data are included in `FloorSnapshot`; full logs and future bundles remain excluded. Repository/preflight mutations increment the session floor revision and broadcast `repository` and `review` invalidations. `review` remains null until real agent-run output exists. Phase 4 must introduce separate authoritative run records and continue to render missing fields as absent rather than inventing defaults.

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply DB --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test the owner/member GitHub connection flow from `docs/github-production.md` against only the disposable acceptance repository, then the empty floor, two-member realtime collaboration, reload persistence, and empty Review screen.

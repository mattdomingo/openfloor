# Agent backend gaps

The current backend persists collaboration state plus Phase 1 repository configuration. A session owner can connect one GitHub App installation/repository through a signed, expiring, single-use callback, select a base branch, optionally configure ordered required-check commands, disconnect, and reconnect. Session members can read the connection. A public bounded webhook route verifies GitHub HMAC signatures before acknowledging deliveries. These records survive reloads, but Phase 1 deliberately performs no GitHub ref or content mutation.

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Model/provider discovery, credentials, execution, cancellation, and retry.
- Repository reconciliation, checkout, worktrees, branches, file scopes, attachments, and code modification.
- Runtime progress, current steps, agent-generated messages, status transitions, and queue consumption.
- Check execution, files changed, diffs, conflicts, review candidates, approval persistence, merge, and deployment.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

Repository connection data is currently session-lobby state rather than part of `FloorSnapshot`. Phase 2 will add candidate/repository invalidation contracts. `FloorSnapshot` still separates persisted collaboration records from nullable review data. A future runtime must write authoritative runtime/review records through authenticated internal APIs, increment the session floor revision, and broadcast `floor.changed`; UI components must continue to render missing fields as absent rather than inventing defaults.

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply DB --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test the owner/member GitHub connection flow from `docs/github-production.md` against only the disposable acceptance repository, then the empty floor, two-member realtime collaboration, reload persistence, and empty Review screen.

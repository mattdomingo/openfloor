# Agent backend gaps

The current backend persists collaboration state plus the Phase 2 repository candidate. A session owner can connect one GitHub App installation/repository, then enable execution to create one server-named candidate branch at the verified base SHA. Owners can reconcile the base and candidate refs; members can read the state. Signed GitHub deliveries are deduplicated and update revoked, inaccessible, renamed, behind-base, or externally-modified state. No repository code is executed and no run branch, commit, pull request, merge, or deletion exists yet.

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Model/provider discovery, credentials, execution, cancellation, and retry.
- Repository checkout, worktrees, run branches, file scopes, attachments, and code modification.
- Runtime progress, current steps, agent-generated messages, status transitions, and queue consumption.
- Check execution, files changed, diffs, conflicts, review candidates, approval persistence, merge, and deployment.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

Repository connection and active-candidate data are included in `FloorSnapshot`; large future logs and bundles remain excluded. Repository mutations increment the session floor revision and broadcast `repository` and `review` invalidations. `review` itself remains null until real run output exists. A future runtime must write authoritative runtime/review records through authenticated internal APIs and continue to render missing fields as absent rather than inventing defaults.

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply DB --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test the owner/member GitHub connection flow from `docs/github-production.md` against only the disposable acceptance repository, then the empty floor, two-member realtime collaboration, reload persistence, and empty Review screen.

# Agent backend gaps

The current floor backend persists collaboration state: agents created by session members, assignments, team and direct messages, assigned or unassigned prompts, queue ordering, and queue merges. These changes synchronize through the existing session WebSocket and survive reloads.

The following capabilities require a separate trusted agent-runtime and repository integration and are intentionally not simulated:

- Model/provider discovery, credentials, execution, cancellation, and retry.
- Repository checkout, worktrees, branches, file scopes, attachments, and code modification.
- Runtime progress, current steps, agent-generated messages, status transitions, and queue consumption.
- Check execution, files changed, diffs, conflicts, review candidates, approval persistence, merge, and deployment.
- Agent editing, archival/deletion, ownership transfer, and queue completion/removal.

`FloorSnapshot` already separates persisted collaboration records from nullable review data. A future runtime should write authoritative runtime/review records through authenticated internal APIs, increment the session floor revision, and broadcast `floor.changed`; UI components must continue to render missing fields as absent rather than inventing defaults.

## Deployment order

1. Run `npm test`.
2. Apply D1 migrations with `npx wrangler d1 migrations apply openfloor-production --remote`.
3. Build with `npm run build`.
4. Deploy with `npx wrangler deploy --config dist/server/wrangler.json`.
5. Smoke-test an empty floor, two-member realtime agent creation, unassigned and targeted prompts, chat privacy, reload persistence, and the empty Review screen.

# AI-assisted conflict resolution

A conflict case belongs to the original prompt group. It coordinates preparation, assessment, agreement, validation, and integration; it is not a new agent or a new user task.

## Integration and immutable versions

The trusted integrator compares the source result with the candidate changes since the source checkout. Git's rename-aware, NUL-delimited change inventory includes old and new paths. Disjoint files take the normal merge path. Overlapping files require an intent assessment even when Git can merge their text cleanly. Textual conflicts enter the same preparation path.

Preparation uses the exact candidate archive, source archive, and verified source bundle. It creates an immutable manifest and per-file artifacts under `conflicts/<case>/<preparation-run>/v2/`. The snapshot records source/candidate SHAs, Git stage identities/modes, and a fingerprint of each complete merge input. Display pages never become application input. Text files up to 2,000,000 bytes may be edited in full; binary, non-UTF8, oversized, and symbolic-link files use complete Git versions. Paths containing spaces or Unicode remain intact. Missing/corrupt artifacts require an explicit refresh.

D1 owns snapshots, proposals, votes, current revision, execution mode, and waiting reason. Legacy questions/selections remain audit history and cannot authorize v2 publication. The original source remains authoritative after candidate movement; an obsolete resolver result never becomes a newly approved source.

## AI and human decisions

AI inherits the original provider, model, and actual billed credential class. It receives both sides' prompts, candidate-wide affected history, the current approved proposal, and prior failures. Completed rollback contributions are excluded. Missing attribution requires an owner decision. AI must report `compatible`, `decision_required`, or `blocked`, explain the result, identify preserved prompt IDs, and provide evidence. A compatible report must cover all attributed intents unless people approved an explicit tradeoff.

Each new snapshot or approved proposal permits at most two AI attempts. Explicit retry cannot reset an exhausted decision budget; propose a revised outcome or refresh changed/missing versions. Preparation and exact manual application make no model calls and do not require model credentials or provider budget. Repository, session membership, runtime availability, session-hours quota, cancellation, and capacity controls still apply. Gated cases remain visible and do not prevent unrelated eligible work.

An intent proposal describes a shared outcome for AI to implement. A manual proposal contains the exact complete-file, section, or edited-text result. Its creator supplies the first approval. All distinct affected active authors must approve the same proposal. A rejection stops execution. Missing attribution or a departed author requires an explicit owner override with a recorded reason. There is no timeout approval. A revision or candidate mismatch rejects the entire write without changing any accepted decision.

Manual section choices preserve untouched text. “Concatenate candidate then incoming” means exactly that concatenation, with a preview; it does not imply semantic compatibility. Complete-file choices replace the entire file with the chosen blob or deletion. Edited text is the complete result, not a patch derived from a preview. Manual failure never invokes AI implicitly.

## Publication, recovery, and UI

No candidate lock is held while AI runs or people deliberate. Immediately before publication/integration, the server rechecks the current attempt, snapshot, source identity, candidate, and approvals. The trusted integrator fast-forwards a resolution through an expected-SHA Git lease after proving ancestry. Candidate movement invalidates the proposal and approvals and starts preparation again. A successful push can be reconciled after Workflow restart by verifying the run commit is already in candidate ancestry.

Cases resolve only after authoritative integration or a checked, explicitly justified no-change result against the exact current candidate. Workflow entry reads live status rather than a cached step result; cancelled or terminal runs cannot restart automatically. Late callbacks are bound to the current attempt.

Queue, agent cards, and Review open one conflict center. Preparation does not mark the original prompt complete. The center shows incoming and integrated intents, AI evidence, proposal, individual approvals, owner override audit, waiting/error messages, and actual run/check history. Drafts survive recoverable request failures; stale versions disable submission until explicitly reviewed or discarded. The manual editor pages sections and loads complete text only on request. Resource authorization errors remain in the dialog rather than ejecting a valid session member.

## Migration and rollback

Migrations `0048_sparkling_patch.sql` and `0049_rare_bulldozer.sql` only add columns, indexes, and tables. No existing table or checked enum is recreated. Existing run, question, selection, and prompt history is retained. Old API payloads receive `409` and must refresh; they cannot bypass consensus. Existing open cases prepare a fresh v2 snapshot before using decisions.

Apply migrations before deploying this code. Keep the added schema on rollback. If application rollback to the old handler is required, disable agent execution first and stop active resolution Workflows; the old handler must not execute v2 proposals. Restore the v2 handler before reenabling conflict execution. Do not delete audit rows or reverse additive migrations to roll back the UI.

## Browser acceptance in a disposable repository

After this PR is authorized and merged to `release`, use `dev.app.opnflr.com` with a disposable GitHub repository and two admitted members. Keep production promotion separate.

1. Connect the repository, start a candidate, and use working provider credentials. Have each member submit a prompt changing the same file in compatible ways. Run both; verify both features and their tests survive in the candidate and one draft PR.
2. Repeat with contradictory requirements whose edits merge cleanly. Confirm the second integration stops for an intent decision. Both members should see both prompts and the same snapshot after reload.
3. Propose a compromise. Confirm one approval alone cannot run it. Reject it from the second account; confirm nothing integrates. Approve the same proposal after discussion; observe validation and exact candidate advancement.
4. Turn automatic conflict resolution off. Cause another conflict. Confirm preparation still produces inspectable files. Open the center from the Queue status or agent card. Choose complete binary/deletion versions, edit a text result, and inspect section concatenation. Submit, obtain agreement, and verify the actual result and checks. No model request should be billed to this attempt.
5. Reject a proposal or remove an affected member. Record a reasoned owner override and verify its audit remains visible after reload. An unrelated member can inspect but cannot propose or vote.
6. Move the candidate while a proposal is awaiting approval or while AI runs. Verify obsolete submissions/output cannot publish, approvals are invalidated, and refreshed versions are explicit. Simulate a transient snapshot read failure and reconnect; drafts should remain until deliberately discarded.
7. Exhaust or disconnect the original provider credential. Confirm waiting reason is actionable and manual work remains available. Cancel an active resolver; confirm no automatic restart. Retry preparation after a recoverable failure, and restart a Workflow after publication to verify idempotent reconciliation.
8. Test keyboard-only navigation and a 390px-wide viewport. Errors, agreement controls, file choices, complete-text editor, and close/back actions must remain reachable.

Automated proof uses real Git for overlap, renames, exact application, stale inputs, binary bytes, and large tails; worker tests for consensus, authorization and lifecycle; a populated-history SQLite transition; and a two-browser flow backed by D1/R2. The browser provider/GitHub adapter is deterministic test data, not proof of a real provider's semantic judgment. The exact Docker image also runs capture/application inside the production namespace.

Semantic assessment remains fallible. Overlap detection does not find contradictory requirements confined to unrelated files. Required repository checks and final human review remain necessary.

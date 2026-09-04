# Josh beta correctness and lifecycle acceptance

Source: the user-approved Josh implementation brief recorded in PR #292. The raw interview PDF is not an implementation specification. These changes are based on `main` at `af50201`; the user explicitly requested PRs targeting `main`, so publication uses the existing `hotfix/*` CI exception. No merge or deployment is performed by this task.

## Changes and evidence

| Items | Outcome | Regression evidence |
| --- | --- | --- |
| BUG-01 | Settings refreshes verified GitHub repository scopes without disconnecting. Unsigned Configure return navigates to verification without granting access. | GitHub D1 scope refresh test; browser refresh, forged installation callback, association preservation and existing-session checks. |
| BUG-02 | Provider options follow rollout gates; disabled saved credentials remain removable. | Provider rendering tests and server PUT gate. |
| BUG-03 | Successful no-change writable tasks complete without a branch or publication, preserving output and task identity. | D1 completion/idempotency/cancellation/capacity tests; terminal re-entry and queue classification tests. |
| BUG-04 | Task suitability filters precede persistent-agent preference; unmatched specialists no longer absorb unrelated work. | Routing mismatch/match/generalist tests and review-intent cases. |
| BUG-05 | Historical queue actions cannot open an unrelated agent. | Exact active-ID guards; retired-agent browser history flow. |
| BUG-06 | Existing explicit branch-preservation/deletion flow already satisfies the confirmed deletion outcome. No lease or deletion safety change. | Existing render deletion tests cover failed branch deletion, preserved session, then explicit orphan choice. |
| BUG-07 | Known exhausted quota is explained before setup; later refusals are focused and scrolled into view. | Browser submission-refusal test preserves entered data and checks focus/viewport. Existing quota enforcement tests remain. |
| INV-01 | Reproduced lazy partial-clone fetch without credentials during thin-bundle import; every trusted publisher Git call now receives transient authentication. | Authenticated local Git HTTP regression forces a promised delta-base fetch; verifies parent SHA and absence of persisted authentication. |
| UX-01–03 | Name and Task replace redundant role input; existing task/model/billing edits remain; Idle and lifecycle controls are explicit. | Browser creation, idle-control, generated-worker Pause/Resume and existing ownership tests. |
| UX-04–05 | Read-only paginated Run history includes inactive agents, output, diffs, activity and raw logs. Failed attempts say Retry. | D1 25-run pagination, retired identity, foreign cursor/member concealment; browser retained-worker expansion and Retry. |
| UX-06 | Git descriptions use a sanitized opening request and run trailer. Sensitive-looking requests receive a neutral title. | Description redaction/bounds tests and publisher commit-message assertion. |
| UX-07–09 | Bare @ opens suggestions; publication phases show real progress indicators; internal session briefs leave normal UI. | Mention query/keyboard browser checks, existing run progression, and history/raw-log visibility assertions. |

## Deployment constraints

Apply additive migration `0046_sad_the_phantom.sql` before the dependent Worker. It adds one nullable column and does not recreate `agent_runs` or its cascading children. Publisher image generation is v3 and executor pool generation v10. A rollback must continue treating existing `ready/no_changes` rows as terminal; do not replay them through older publication logic.

SEC-01 is a separate security implementation and review. This PR does not claim the existing shell-only boundary contains provider-native file tools or trusted post-run Git. PD-* backlog/product decisions, SEC-02 package/network policy, BETA-01 archival changes, and ignored interview material remain outside this batch.

## Browser acceptance after an authorized development deployment

1. In Settings, change GitHub App repository selection, return through Configure, verify access, and confirm the new repository appears without removing the association. Confirm another member sees only their verified repositories. A failed verification must preserve the previous connection.
2. Confirm Onboarding and Settings omit unconfigured disabled providers while any previously saved disabled credential remains visibly unavailable and removable.
3. Create a named agent with a testing task. Submit unrelated design work with automatic agents off: it should be held until manually assigned. Matching test work should reach the specialist. Task/model/billing edits retain their existing ownership rules and affect later runs.
4. Ask a writable agent for work already satisfied by the repository. Confirm final output survives, the queue says Completed, no run branch is created, and subsequent work can use its capacity. Actual provider failures still fail; a conflict resolver cannot complete successfully without resolving changes.
5. Retire a generated worker or remove an idle persistent agent. Open Run history, expand its old run, inspect output/activity/raw logs, and load older runs. Historical queue details must not open a different active agent. Internal session briefs must not appear.
6. Confirm a new agent is Idle with inactive Pause/Stop. Type @ and choose a suggestion with the keyboard. During a changed task, verify Preparing publication/Publishing/Waiting to integrate/Integrating follow actual run state; Retry appears only for failed queue attempts.
7. Inspect the resulting Git commit and integration description: the opening request is recognizable, the run trailer remains, and synthetic credentials included on later prompt lines never enter the description.
8. Attempt creation with exhausted session hours. Confirm immediate quota guidance. If quota expires while the form is already open, confirm submission refusal remains visible and focused without losing inputs.
9. With an unmerged candidate, attempt session deletion. Confirm explicit branch choice, session preservation if safe deletion fails, and expected-SHA checks remain enforced. Use only a disposable repository for this destructive acceptance action.

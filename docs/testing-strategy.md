# Testing Strategy

> Moved out of `CLAUDE.md` on 2026-08-29 to keep that file under the size threshold. This is the authoritative source for the full coverage lists for each test layer — keep it factually correct the same way `CLAUDE.md` itself must stay correct (update it in the same change as any behavior it describes).

---

### Unit tests

Use for pure behavior:

- Identity claim parsing and development fallback isolation.
- Invite signing and verification.
- GitHub callback-state signing, expiry/one-time consumption, and webhook HMAC verification.
- Validation and normalization.
- Date formatting that is deterministic across server and browser.
- Queue merge selection, mentions, and revision decisions.
- Presence and typing-draft reducers.
- Everyone/Typing/Hidden draft selection.
- Conflict validation, state/prompt rendering, notification event selection/deduplication, and real multi-file three-way workspace construction.
- Production deploy-artifact identity: exact D1 database ID, reviewed `AGENT_RUN_ENABLED=true` beta posture, and rejection of test-only variables.
- Broker credential separation, pinned routes/queries, streaming and legacy SSE endpoint rewriting; bounded nofollow artifact reads and prefix reads; transcript archive traversal/link/size/overwrite refusal.
- Preview package-manager detection and frozen install commands for npm, pnpm, Yarn, and Bun; lifecycle-script suppression flags; single-port selection; runtime-token validation; hostname parsing; Access credential stripping; host-only cookie preservation; and CSP framing replacement.

### Sandbox image tests

Pull-request and branch CI build `Dockerfile.sandbox` and run `/opt/openfloor/runtime-isolation-test.sh` inside that exact image. Tests exercise native file access, hidden host files/process state, zero capabilities and `no_new_privs`, forbidden external network access, read-only reply mounts, hostile Git filters, real Unix-socket/loopback broker transport, cancellation flushing, and detached-descendant termination. Pinned Codex, Claude, Gemini, and Qwen executables must also start inside the namespace. Preview coverage installs npm, pnpm, Yarn, and Bun fixtures with lifecycle scripts suppressed, then proves loopback HTTP works while outbound network and capabilities stay denied. These Linux tests are mandatory; macOS unit tests cannot prove namespace containment. Live model/tool/stream/resume acceptance remains distinct from CLI startup and is documented in `docs/josh-beta-runtime-isolation.md`.

### D1 integration tests

Use the Cloudflare Vitest worker pool and local migrations to test:

- User upserts.
- Session creation and member-only listing.
- Membership uniqueness and concealment.
- Invite acceptance, rotation, and revocation.
- Owner/non-owner leave behavior.
- Empty new floor snapshots.
- Agent uniqueness and same-session ownership.
- Assignment, message, DM privacy, queue, ordering, and merging behavior.
- Revision increments and persistence after reread.
- Owner-only repository setup/disconnect, member reads, outsider concealment, and ordered required-check persistence.
- Candidate uniqueness, webhook delivery deduplication, failed-processing claim release for redelivery, behind-base reconciliation, and external candidate mutation detection.
- Stripe signature rejection, event replay/order behavior, plan/status/quantity projection, paid-onboarding completion, and dynamic invite seat enforcement.
- Preflight uniqueness, ordered state recovery, terminal failure/timeout state, gateway-token binding, and R2 log authorization.
- Conflict default-on migration preservation, idempotent detection, priority/capacity routing, retry budgets, provider/quota handling, owner/member authorization, cross-session concealment, exact-question answer races, runtime-token binding, and ended-session refusal.
- Model gateways accept run-scoped spend authority only while a run is exactly `running`; `cancel_requested` rejects OpenAI, Anthropic-compatible, Gemini, and OpenAI-chat-compatible traffic before credential lookup or upstream fetch.
- Integrated-run rollback authorization for session owners, agent owners, and every-prompt authors; owner-only engineer/agent groups; mixed-author and separately-removed-file exclusion; exact preview SHA/run-set rejection; pagination beyond 20 runs; newest-first atomic child completion/failure; failed-attempt retry; legacy-row preservation; candidate lease release; audit preservation; Queue status; and active/History Review behavior.
- Reviewed-file removal owner authorization and outsider concealment; path/SHA validation; exact candidate/base lease checks; failed/completed audit and lease release; added/modified/deleted/renamed Git tree behavior; preservation of unrelated files; active-attribution cutoff; and later same-path contribution recovery. Browser coverage pins right-click discovery, info attribution, utility actions, confirmation, and removal of middle-diff banners.
- Repository preview owner authorization, outsider concealment, early-access revocation, exact candidate and generation races, three-preview concurrent capacity, stale fallback, expiry, host revocation, and retryable Sandbox cleanup intents.

### Durable Object tests

Cover:

- Authenticated upgrade and unauthorized rejection.
- Two-user presence.
- Multiple-tab online deduplication.
- Disconnect behavior.
- Hibernation restoration.
- Member, session, and floor notifications.
- Ephemeral draft broadcast.
- Draft restoration after hibernation.
- Multiple-tab draft aggregation and fallback when one tab closes.

### Rendering tests

Build the Worker and verify:

- Public landing content.
- Protected redirects.
- Product metadata.
- Authenticated empty floor rendering.
- Absence of seeded agents, prompts, files, checks, or branches.
- Presence of current floor controls without relying on client-only mounting.
- Nothing is served outside the configured base path in the production build.

### End-to-end tests

The Playwright test uses two authenticated browser contexts and verifies the real flow:

- Owner creates a session and shares an invite.
- Member explicitly joins.
- Both see presence and enter the floor.
- Objective edits synchronize.
- Agent, prompts, assignments, team chat, and DMs persist and synchronize.
- Queue targeting and merging work.
- Live teammate draft text appears in realtime.
- Typing, Everyone, and Hidden draft modes behave correctly.
- Review stays empty without fabricated repository data.
- Preview UI stays absent while its rollout gate is off; component coverage pins owner/member controls, provisioning, ready iframe, stale failure fallback, expiry, responsive browser chrome, and absence of iframe top-navigation permission.
- Signed GitHub webhook rejection/acceptance and the owner/member repository connection, candidate synchronization, passing/failing preflights, real-output viewing, retry, and reload recovery through deterministic test-only GitHub/Workflow/Sandbox adapters.
- Default conflict automation, automatic and manual resolver states, owner/original-author answers, unrelated-member waiting UI and concealed rejection, stale-answer rejection, reload durability, browser-permission handling, one hidden-tab notification, and exact Review click-through.
- Reload persistence, disconnect/reconnect, leave, and roster updates work.

When adding a collaborative feature, prefer extending this two-context flow over testing only one browser.

Engineer attribution coverage includes authenticated GitHub identity validation, one-use callback binding, multi-author execution gates, source-inherited resolver identity, deterministic real-Git publication, candidate-wide squash credit, account deletion, a populated-schema migration transition, and two-user browser verification/restart/history flows. The isolated E2E server seeds one explicitly legacy account without GitHub proof; production never imports that fixture.

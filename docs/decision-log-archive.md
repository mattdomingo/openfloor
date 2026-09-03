# Decision log archive

Entries from [`decision-log.md`](decision-log.md) whose decision was superseded in its entirety — kept for history, not needed for day-to-day reads. Each is replaced in the main log by a one-line pointer at its original position.

### 2026-08-19 — Temporarily deliver repository phases directly to production

**Status:** Superseded by "Permanent release branch deploys an isolated development environment" (2026-09-03); retained for history.

**Decision:** Until the user establishes a staging environment, deploy each accepted repository-execution phase to the existing production openfloor Worker and D1 database at `opnflr.com/app`. Use a real disposable GitHub repository as the only App installation target during acceptance.

**Rationale:** Reusing the working production application, Access policy, domain, and bindings removes a second environment's DNS, Access, secret, and deployment setup from the critical path. A disposable repository limits the GitHub-side impact while the integration matures.

**Consequences:** The unused `openfloor-development` D1 database may remain for later cleanup but is not referenced by application configuration. Production migrations must precede code deployment. The five GitHub App secrets must be configured before deploying the repository UI, and each phase must still pass the complete pipeline and stop for explicit browser acceptance. Expanding the App beyond the disposable repository requires a separate deliberate decision.

### 2026-08-19 — Two themes from one token sheet

**Status:** Superseded by “Add Polar and Midnight as explicit manual product themes” (2026-08-22); retained for history.

**Decision:** The cream palette is the light theme; a warm-charcoal dark theme overrides the color tokens in `tokens.css` — once under `prefers-color-scheme: dark` (system default) and once under `[data-theme="dark"]` (manual override), kept identical. A ThemeToggle in both headers cycles System → Light → Dark, persisted per device in localStorage and applied pre-paint by an inline script in the root layout. The code workbench's inverse surfaces and the identity tints stay unchanged in both themes.

**Rationale:** Every color already resolves through `tokens.css` (the components had no literal colors worth keeping except the workbench's), so a theme is one override block, not a rewrite. System-following alone was not enough — people demo on projectors and override their OS.

**Consequences:** New colors must be tokens with values in all three blocks. The two dark blocks must stay byte-identical. Theme choice is per-device local state, never synced.


### 2026-08-25 — Withhold the ChatGPT-bundle kind from the UI until §5 ships

**Status:** Superseded by "Accept a ChatGPT subscription for Codex runs" (2026-08-26) — Spike D ran and passed, so the kind is live. Retained for history.

**Decision:** `credentialKindsForProvider("openai")` narrows to `["api_key"]`. Settings no longer offers a ChatGPT subscription row, the PUT route refuses `{ authJson }` for every provider with `400`, and the create-agent dialog's Billing field disappears for openai (one kind). The authJson parse shape, the dormant Settings bundle form, and the openai gateway's own oauth-kind refusal all remain in place, §5-ready.

**Rationale:** §1 shipped the connect surface for both subscription kinds, but §5 (ChatGPT-subscription Codex) is gated on Spike D, which has not run and which the brief expects to fail. Until it ships, a member could connect a bundle whose every run 503s at the gateway guard — offering a connection openfloor cannot honor only manufactures failures. Withholding the kind at `credentialKindsForProvider` closes the front door in one place; the gateway guard stays as defense in depth for hand-written rows (the resolver's kind check now refuses those first).

**Consequences:** If Gate D ever passes, §5 re-widens the kinds list and the dormant surfaces light up unchanged. `DELETE ?kind=oauth` on openai is a `404` like any other unsupported kind. Worker/render/unit tests pin the withheld state.


### 2026-08-24 — Guide new session owners through repository setup and optional personal credentials

**Status:** Superseded by “Require account-level GitHub installation and provision candidates during session creation” (2026-08-26); retained for history.

**Decision:** After `POST /api/sessions` succeeds, the home screen navigates the creator to `/session/[id]?setup=1`. The owner-only lobby opens a two-step dialog: the existing repository connection/candidate workflow first (required by `isRepositoryReadyForFloor`), then the current user’s rollout-enabled provider credentials (optional). `github=setup` resumes the repository step after the signed GitHub callback; `repo=required` continues to open only the focused floor-entry gate. Closing or finishing setup removes the query state. `RepositoryCard` remains the repository mutation owner and reports its authoritative repository/candidate results to `SessionScreen`; the shared `ProviderCredentials` component remains a client of the existing per-user write-only credential APIs.

**Rationale:** New owners previously landed in a dense lobby with repository setup separated from the floor action and provider credentials available only in account settings. A resumable lobby workflow makes the real prerequisites legible without introducing session-owned keys, a second repository state machine, or a weaker definition of floor readiness. Keeping the focused floor gate distinct means an ordinary failed floor attempt cannot unexpectedly start a multistep onboarding flow.

**Consequences:** `setup=1`, `github=setup`, and `repo=required` are UI-only query contracts. Setup never auto-opens for members, ended sessions, or normal return visits. “Set up later” is not persisted and does not mark anything complete; repository readiness still comes only from the existing connection/candidate records. Provider values remain encrypted, last-four-only on reads, and resolved per run as agent-owner key, then server key, then clear refusal.


### 2026-08-25 — Split first-login onboarding into profile and plan steps (plan step hidden 2026-08-27)

**Status:** Superseded by “Require account-level GitHub installation and provision candidates during session creation” (2026-08-26); retained for history.

**Decision:** `/onboarding` is a two-step local-state flow in `OnboardingScreen`: profile picture/name/GitHub handle first, then explicit Free/Pro/Max selection and paid seat quantity. Both panels stay mounted while navigating Back/Continue so unsaved values and the avatar preview survive within the page; reload starts again at profile and nothing is persisted until the final submit. A server-validated invite return replaces plan selection with a locked Free confirmation, but final onboarding still returns to the existing invite preview and never accepts membership automatically.

**Rationale:** Separating identity from billing makes the required choices easier to scan without adding a draft entity or weakening the existing single onboarding mutation. Reusing the API's final multipart submission keeps profile validation, invite verification, Stripe Checkout, safe redirects, and membership acceptance at their current authoritative boundaries.

**Consequences:** The current step and every unsaved field belong only to `OnboardingScreen`; no schema, API, Access, billing, or invite contract changed. The screen now shares the shop palette, wave field, Archivo type, bracket buttons, and theme resolution used by `/home` and the lobby, while onboarding-only responsive/rounded-surface rules remain scoped under `.onboarding-shell` in `app/styles/shop.css`. Step changes focus the active heading, progress exposes `aria-current="step"`, inactive panels are hidden, and narrow layouts stack profile, plan, seat, and action controls.


# Task: add Claude as a second agent provider in openfloor

> Planning/research brief. This may describe an earlier state; consult AGENTS.md and implemented-features.md for current behavior. It is not an instruction to start new work.

You are working in the openfloor repo, branching off `main`. Read `AGENTS.md` before writing anything — it is the authoritative spec for this codebase, and the "Mandatory maintenance rule" at the top applies to this change. `README.md` covers setup and the manual plan-grant runbook.

## What exists today

openfloor runs exactly one agent provider, wired in at five fixed points:

- `db/runs.ts:5` — `AGENT_RUN_MODEL = "gpt-5.6-terra"`, a module constant. No per-agent or per-session model choice.
- `db/schema.ts` — `agent_runs.model` (text) and `agent_runs.codex_thread_id`. `floor_agents` has **no** provider or model column.
- `scripts/codex-runner.mjs` — `new Codex({baseUrl, apiKey, config: {mcp_servers}})`, `thread.runStreamed()`, and `normalizeItem()`, which maps Codex stream events onto openfloor's activity kinds (`command`, `reasoning`, `file_edit`, `agent_message`, `tool_call`, `error`).
- `Dockerfile.sandbox` — installs `@openai/codex-sdk@0.148.0` and `@modelcontextprotocol/sdk@1.30.0`, copies `scripts/*.mjs` into `/opt/openfloor/`.
- `worker/agent-run-workflow.ts:159-175` — `sandbox.startProcess("node /opt/openfloor/codex-runner.mjs", {env: {OPENFLOOR_OPENAI_BASE_URL, OPENFLOOR_OPENAI_TOKEN, OPENFLOOR_MODEL, OPENFLOOR_EVENTS_*, OPENFLOOR_CONTEXT_*, OPENFLOOR_MCP_SERVER_PATH, ...}})`.
- `app/runtime/openai/[...path]/route.ts` — the credential gateway. Verifies a short-lived run-scoped JWT, then forwards only `POST /v1/responses` to `api.openai.com` using the server's `OPENAI_API_KEY`, so the sandbox process never holds a provider credential.
- `scripts/openfloor-mcp.mjs` — the only MCP server, hardcoded: one read-only tool `openfloor_session_context`, backed by `GET /runtime/run/context`.

Plan enforcement lives in `lib/plans.ts` + `db/sessions.ts` (`getOwnerHourQuota`, `getUsageForUser`) and is gated at exactly four spend initiators. `AGENTS.md` § "Plan limits and metering" explains why it is **not** folded into `getActiveMembershipRole`, and lists the wind-down set that must stay ungated. Do not widen those gates.

## Step 0 — RESOLVED

The spike ran. Result: kernel-level isolation **is** available in Cloudflare's Sandbox runtime, conditional on the runner executing as a non-root user.

Cloudflare Sandbox containers are Firecracker microVMs (`6.18.36-cloudflare-firecracker`), not Docker-style confined processes: full capability set including `CAP_SYS_ADMIN`, `Seccomp: 0`, `max_user_namespaces = 24721`. Nothing filters syscalls inside the VM, so both blockers seen under local Docker — the `CLONE_NEWUSER` seccomp filter and masked `/proc` — are absent. `bwrap --dev-bind / / true`, `unshare -Ur true`, and the `--unshare-pid --proc /proc` remount all pass, as root and as a non-root user.

`@anthropic-ai/sandbox-runtime` (`srt`) works end to end **as a non-root user only**. As root its `apply-seccomp` helper fails at `write /proc/self/uid_map: Operation not permitted` inside the user namespace it creates. Bare `bwrap` works as root; the tool actually used does not.

Consequences for §2 below, which is no longer provisional:

- The Claude runner can have the same two isolation layers as the Codex runner — microVM outside, `srt` kernel sandbox inside — provided `claude-runner.mjs` runs as a dedicated non-root user.
- That is a real work item, not a footnote: everything in the sandbox runs as root today. The runner needs a user-setup step, `chown` on the workspace paths the agent touches, and the root-side pipeline (git, event posting, bundle export) kept outside the inner sandbox — the same shape as the Codex SDK wrapping only agent commands.
- `bubblewrap`, `socat`, and `ripgrep` get baked into `Dockerfile.sandbox` with the `RUN_SANDBOX_IMAGE_VERSION` bump. The probe's runtime `apt-get` was convenience only.
- `srt`'s network control is a **proxy-enforced domain allowlist**, not Codex's on/off flag. The decision log documents those semantics; it does not claim equivalence.

## Step 0 — original spike brief, retained for context

Codex gets its execution posture from the Codex CLI's own kernel-level sandbox (`networkAccessEnabled: false`, `sandboxMode: "workspace-write"`). The Claude Agent SDK has no equivalent flag. Claude Code's Bash sandbox on Linux depends on `bubblewrap` and `socat`, plus an optional seccomp filter package, and bubblewrap needs unprivileged user namespaces — which may or may not be available inside a Cloudflare Sandbox container. Its network isolation is also a **domain allowlist enforced by a local proxy**, not an on/off switch, so its semantics differ from Codex's even where it works.

Spike it in two stages, and report before any schema work lands.

**Do not build, tag, or push container images by hand, and do not touch registry credentials or credential helpers.** `wrangler deploy` already builds and pushes `Dockerfile.sandbox` (`wrangler.jsonc:56-59`, `deploy.sh`). If a step seems to need `crane`, `skopeo`, `docker login`, or a credential helper, stop and say so rather than working around it.

**Stage A — local, no registry, no deploy.** Run the same base image locally (`docker run --rm cloudflare/sandbox:0.12.7 bash -lc '<checks>'`) and answer:

1. Do `bubblewrap` and `socat` install in this image?
2. Does `bwrap --dev-bind / / true` succeed, or fail on user namespaces?
3. Does `unshare -Ur true` succeed?
4. What does `@anthropic-ai/sandbox-runtime` report as missing?

Report Stage A before going further. If bubblewrap cannot work in the base image at all, the spike is finished — the answer is "no kernel-level isolation available for the Claude runner," and §2 and §4 get rewritten around that.

**Stage B — only if Stage A passes, and only through the normal path.** Add the packages to `Dockerfile.sandbox`, bump `RUN_SANDBOX_IMAGE_VERSION`, deploy with `npx wrangler deploy`, and repeat the same four checks inside a real Sandbox container. Cloudflare's container runtime may differ from local Docker on user namespaces specifically; that is the only question Stage A cannot settle.

The result decides the shape of both §2 and §4, so treat everything below as provisional until it comes back. The deliverable either way is an accurate written statement of the resulting posture in `AGENTS.md`'s decision log — not a claim that it matches Codex's.

## 1. Provider-agnostic credential store

Users connect their own Anthropic credentials; openfloor uses them for that user's runs instead of the server key.

- New table keyed by `(user_id, provider)`, where `provider` is an open enum starting with `anthropic` and `openai`. Store a `kind` discriminator (`api_key` today) so another credential shape can be added later without changing row identity.
- Encrypt values at rest. There is no KMS binding today — add one, or derive an AES-GCM key from a Worker secret. Pick one and record the choice in `AGENTS.md`'s decision log.
- Stored values are write-only from the client's perspective: no endpoint returns one. `/settings` shows connection state, a last-four fingerprint, and a disconnect action.
- Validate on connect with `GET /v1/models` (free, no tokens) and store the result. A key that later stops working surfaces as a run failure with a clear message — never a silent fallback to the server key.
- Resolution order per run: the **session owner's** credential for the run's provider, else the server-configured key, else refuse the run. Owner rather than run initiator, because the owner is who the plan quota already bills.

**Do not build claude.ai / Max / Pro subscription login.** Anthropic's Agent SDK docs state: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* openfloor is a third-party product. Shape the schema so a `kind: "oauth"` row slots in unchanged if approval is granted later, leave a `ponytail:` comment saying so, and ship no UI for it.

## 2. A Claude runner alongside the Codex runner

Use the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — not the Anthropic Client SDK, not Managed Agents. It is Claude Code as a library: it supplies the agent loop and the built-in Read/Write/Edit/Bash/Glob/Grep tools, which is what the Codex runner gets from the Codex SDK today. Docs are at `code.claude.com/docs/en/agent-sdk/*`; read the TypeScript reference, the MCP page, and the skills page rather than working from memory.

- `scripts/claude-runner.mjs`, structurally parallel to `codex-runner.mjs`: same env-var contract (`OPENFLOOR_PROMPT_PATH`, `OPENFLOOR_RESULT_PATH`, `OPENFLOOR_WORKSPACE`, `OPENFLOOR_EVENTS_*`, `OPENFLOOR_CONTEXT_*`), same `result.json` shape, same best-effort activity telemetry that must never fail the run.
- Route model traffic through a new `app/runtime/anthropic/[...path]/route.ts` gateway mirroring the OpenAI one — same JWT verification, same run-status check, same narrow path allowlist, SSE passthrough. The runner reaches it via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (the run-scoped JWT), keeping the provider credential out of the sandbox process as today.
- Do not hardcode the gateway's path allowlist from spec. Start with `POST /v1/messages` and `/v1/messages/count_tokens`, log every rejected path during the spike, and finalize the list from observed traffic — the CLI may call `/v1/models` or others.
- Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and disable telemetry so the CLI makes no calls beyond the gateway.
- Map the SDK's message stream onto openfloor's existing `agent_run_events.kind` values. They map cleanly; do not invent new kinds and do not change the UI.
- Configure `permissionMode` so a run never blocks waiting for human approval, and set the execution posture to whatever Step 0 established.
- Default model: `claude-opus-5`.
- `Dockerfile.sandbox` gains the SDK, and `RUN_SANDBOX_IMAGE_VERSION` in `worker/agent-run-workflow.ts` **must** be bumped — pooled run sandboxes are keyed by it, and a stale pooled container would otherwise be claimed by a live run without the new scripts.
- Add `provider` (and a nullable per-agent `model`) to `floor_agents`, defaulting to current behavior so existing rows keep working. Replace the `AGENT_RUN_MODEL` constant with per-provider defaults.
- **Do not rename `agent_runs.codex_thread_id`.** It has four inbound `ON DELETE CASCADE` foreign keys (`db/schema.ts:445,458,480,496`) plus a set-null at 513 — the same shape as the documented `users` invariant in `AGENTS.md` § "Persistence model". `drizzle-kit generate` cannot detect a rename non-interactively and emits a table recreate, which `drizzle/0019` documents as cascade-deleting child rows despite the `PRAGMA foreign_keys=OFF` wrapper. Keep the column, expose it as `providerThreadId` in TypeScript, and add one line to the legacy-naming section next to `chatgpt_user_id`.

## 3. Importable Claude skills

Session owners upload or paste skills; a Claude run discovers them.

- The Agent SDK discovers skills from the filesystem: one directory per skill containing `SKILL.md` with `name` and `description` frontmatter. The `skills` option scopes which discovered skills Claude may invoke, and the SDK adds the `Skill` tool to `allowedTools` automatically.
- Materialize imported skills into the container home directory (`~/.claude/skills/<name>/SKILL.md`) with `settingSources: ["user"]` — **not** into `<repo>/.claude/skills/` with the `project` source. Two reasons: anything written into the git worktree becomes a changed path that the run commits and `publish-bundle.mjs` then validates against `OPENFLOOR_EXPECTED_PATHS`; and the `project` source also loads the target repository's own `.claude/settings.json`, `.mcp.json`, and `CLAUDE.md`, which is configuration openfloor does not control. User scope keeps both out.
- The repository's own `CLAUDE.md` is still useful context. Read it as text and append it into the existing session brief (`lib/session-context.ts`) rather than reintroducing it as a settings source.
- Persist skills per session, not per user, so the floor's agents share them. Materialize them in the same workflow step that already fetches repository source.
- Skills are user-supplied content that becomes agent instructions, so validate on the way in: bound size and count, require well-formed frontmatter, reject path separators and traversal segments in the skill name, and set the run's tools from `allowedTools` only — a skill's `allowed-tools` frontmatter must not widen them (in SDK sessions that field is already inert for filesystem skills; keep it that way).
- Do not implement claude.ai skill sync.

## 4. Configurable MCP servers

Today `scripts/openfloor-mcp.mjs` is the only MCP server and it is hardcoded. Let openfloor session owners configure their own.

- Per-session config: name, transport, url/headers, and an enabled flag. Credentials in that config follow §1's storage and write-only rules.
- Both runners consume one shared internal type, with one serializer per provider — the Agent SDK takes `options.mcpServers` keyed by name, the Codex SDK takes `config.mcp_servers`. This is the piece that makes Codex parity nearly free later, so do not shape the internal type around Claude.
- Tools are enabled explicitly per server (`mcp__<server>__*`). Do not blanket-approve via a permission mode.
- `openfloor` is a reserved server name that users cannot claim, and `openfloor_session_context` is always present and not user-removable.

**v1 scope: remote `http`/`sse` servers only, connecting directly from the container. Defer `stdio`.** Do not build an openfloor-controlled egress proxy for this milestone.

Record this in `AGENTS.md`'s decision log accurately. The honest statement is that the control here is owner-gating plus the reserved-name list — *not* that container egress was already unrestricted. Today the agent process itself performs no model-directed network calls; a configured MCP server is a direct, single-call channel for session content to reach a host the owner configured. That is a real change in what the agent can do, it is an acceptable one because a session owner chooses each server, and the log should say exactly that so it still reads true under a later audit. If Step 0 forces container-level connectivity controls anyway, reopen the proxy question then.

## Constraints

- Follow `AGENTS.md`'s invariants: real data or an honest empty state, authorization enforced server-side, 404 concealment for unauthorized resources, floor mutations returning the authoritative snapshot.
- Schema changes go through `drizzle-kit generate` (`npm run db:generate`). Every migration must be additive and safe against live rows; see the `users`-recreate invariant before touching any CHECK-constrained column.
- Owner-only for every new mutation (credentials are per-user; skills and MCP config are per-session and owner-gated).
- Ending, leaving, cancelling, discarding, merging, and the rest of the wind-down set stay ungated.
- `npm test` runs typecheck, lint, unit, migration, worker, render, and e2e suites. All of it must pass. Add unit tests for the new pure logic (credential resolution order, MCP config serialization per provider, skill frontmatter validation) and a worker test for the new gateway route's rejection paths.
- Update `AGENTS.md` (implemented list, deferred list, API contract table, repository map, decision log) and `docs/agent-backend-gaps.md` in the same change. `AGENTS.md:182` currently lists "Agent model/provider selection and user-managed provider credentials" as explicitly deferred — that line stops being true.

## Sequencing

Step 0 spike, then: schema + credential store; Claude runner + gateway behind a disabled rollout flag; provider selection in the UI; skills; MCP config. Each piece independently green. Keep every rollout gate off until its image, credentials, and prerequisites are live — the existing convention in this repo.

## Out of scope

Token- and cost-metering. `codex-runner.mjs` already captures `usage` from `turn.completed` and `parseCodexResult` (`worker/agent-run-workflow.ts:564`) discards it; API-usage accounting is separate work. Have the Claude runner capture the equivalent field, note it in `AGENTS.md` for that future work, and stop there.

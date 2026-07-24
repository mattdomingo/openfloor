# OpenFloor project context

Last updated: 2026-07-23

## Product statement

OpenFloor is a multiplayer development environment for teams coordinating several coding agents against one shared software objective. It is a control plane above repositories and agent runtimes, not a shared chatbot and not a replacement IDE.

The main product surface is structured current state: sessions, tasks, agents, participants, artifacts, decisions, conflicts, patches, and checks. Chat is a continuously available command surface for dispatch and steering. The chronological event stream is an audit trail, not the primary interface.

## Initial user and proof point

The first user is a small software team already using Codex or Claude Code. The first convincing demo should show three humans joining at different times, dispatching parallel backend, frontend, test, and review work, resolving an overlap, integrating isolated patches in a controlled order, and understanding the session without reading a transcript.

## Repository state at project start

The repository contained only a README with placeholder text and no application, architecture, tests, or project-specific instructions. The first implementation is therefore a standalone mocked web prototype intended to validate the session model and primary interface.

## MVP architecture

### Web control plane

- React/TypeScript interface for objective, task graph, live agents, participants, repository state, decisions, conflicts, and checks.
- Initially driven by a deterministic in-memory event fixture; later consumes the backend event stream over WebSocket.
- Derives current session state by reducing ordered domain events. Raw terminal output is retained as an agent-detail artifact, never treated as canonical session state.

### Backend coordinator

- WebSocket gateway for participants and registered runners.
- Append-only event store with monotonic per-session sequence numbers.
- Command and approval router with idempotency keys.
- Materialized session projections for fast late-join snapshots.
- Orchestrator service for task contracts, dependency ordering, scope claims, and conflict creation.

### Local runner

- Outbound authenticated connection to the coordinator.
- One branch and Git worktree per worker task; no concurrent workers share a writable directory.
- Agent adapter interface so Codex, Claude Code, and a future hosted environment can emit the same normalized protocol.
- Emits file observations, command lifecycle, checks, and patch metadata; Git remains the authority for code.
- Recovers by resuming from the last acknowledged command/event sequence.

### Reviewer and integration

- Candidate patches integrate into a temporary checkout of the canonical session branch.
- Deterministic checks run per task and again against the combined state.
- Reviewer judgment can create remediation tasks or decisions but cannot override failing deterministic checks or repository permissions.
- Successful integrations retain task, agent, participant, commit, and check attribution and can be rolled back independently.

## Initial data model

- `Session`: objective, repository, canonical branch/SHA, lifecycle, participants, event cursor, current integration candidate.
- `Task`: contract, creator, dispatcher, role, dependencies, owned/prohibited paths, acceptance checks, status, base SHA.
- `Agent`: runtime, adapter, task, launcher, status, plan, worktree/branch reference, heartbeat, event cursor.
- `Participant`: identity, presence, role, last-seen cursor, approvals and instructions.
- `Artifact`: typed reference to patch, commit, file, diff, command output, test result, plan, or log.
- `Decision`: question, options, affected tasks, owner, resolution, and superseded assumptions.
- `Conflict`: category, stage, evidence, affected tasks/artifacts, severity, and resolution.

## Event protocol decisions

Events are append-only envelopes with `event_id`, `session_id`, `sequence`, `occurred_at`, `actor`, `type`, `schema_version`, `causation_id`, `correlation_id`, and a typed `payload`. The backend assigns the canonical session sequence. Runner submissions include a stable client event ID so retries are idempotent.

The first protocol should support:

- session and participant lifecycle;
- task creation, planning, assignment, dependency, and status;
- agent start, heartbeat, plan, status, question, and stop;
- scope request/grant/release and file read/modified observations;
- command request/approval/start/completion;
- conflict detection and resolution;
- decision requirement and resolution;
- patch readiness, review, integration, and rollback;
- check start/completion and task completion.

Late join uses a versioned session snapshot plus events after its cursor. Snapshots are derived caches; the event log and Git history remain authoritative.

## Conflict policy

Conflicts are handled at planning, runtime, and integration. Only affected tasks pause. Path claims are advisory for reads and exclusive for writes by default, with explicit shared or read-only modes. Text overlap can be detected mechanically; semantic and architectural conflicts require evidence and may produce a structured human decision. Any task based on a superseded SHA or decision is marked stale before integration.

## First vertical slice sequence

1. Validate the shared-session interface with deterministic mocked events and interactions.
2. Extract the UI fixture into typed event envelopes and implement a pure reducer plus replay tests.
3. Add a minimal coordinator with session creation, append-only SQLite/Postgres events, snapshots, and WebSocket fan-out.
4. Build a mock runner that registers, accepts task contracts, and replays scripted agent/file/check events.
5. Implement the local runner’s Git worktree lifecycle and patch preparation without launching real agents.
6. Add one real agent adapter behind the same runner contract, explicit command approvals, and reconnect recovery.
7. Add temporary combined integration, deterministic checks, reviewer output, and remediation tasks.

## Recorded assumptions and open decisions

Assumptions for the first slice:

- One repository per session; one canonical session branch.
- Desktop web is primary, with a usable monitoring/dispatch view on mobile.
- Authentication, persistence, and real runner connectivity are deliberately excluded from the mocked prototype.
- File ownership begins as path-prefix claims and can later add symbol-level awareness.
- Orchestrator recommendations are visible and reversible; humans retain final authority for decisions and approvals.

Decisions to make before real runner work:

- Primary backend/runtime and database choice.
- Repository registration and runner authentication model.
- Whether integration is cherry-pick-first, patch-apply-first, or supports both.
- Exact task cancellation, timeout, and orphaned-worktree recovery semantics.
- Minimum permission policy for commands, environment variables, secrets, and network access.
- Data retention and privacy policy for raw agent logs and command output.
- Which real agent runtime to support first and what adapter capabilities are mandatory.

## MVP acceptance criteria

- Multiple humans see the same objective and structured session state.
- A human can dispatch new work without leaving the main session view.
- Multiple agents show launcher, task contract, plan step, status, owned/observed files, and progress.
- A planned scope conflict can be resolved without pausing unrelated agents.
- Changed files, per-file attribution, integration order, and deterministic checks are visible together.
- A late joiner can identify completed, active, blocked, and queued work, decisions, conflicts, artifacts, and test health from the current-state view.

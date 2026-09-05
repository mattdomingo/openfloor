# Josh beta SEC-01: implemented runtime boundary

The authoritative scope is `josh-beta-2026-09-04-codex-implementation-brief.md`.
The historical flow, hostile Git-filter reproduction, and migration reasoning
remain in `josh-beta-runtime-isolation-plan.md`.

## Behavior and ownership

Previously, a provider process held short-lived tokens outside a shell-only
sandbox. Native file tools were not covered by that seam. Agent-writable Git
configuration could also execute filters during trusted post-run Git staging.

Now the complete provider and all tools run as uid 10002/gid 10001 with zero
capabilities and no_new_privs in a mount, PID, IPC, UTS, and network namespace.
The fixed filesystem contains read-only system/execution dependencies, the
repository, scratch, and optional read-only attachments. Reply runs mount the
repository read-only. Broker, publisher, artifact-reader code, host service,
credentials, and outside process state are absent. Failure to create the
namespace fails execution; no unsandboxed fallback exists.

The root broker retains run-scoped tokens and fixed upstream destinations.
Only its Unix socket is bound into the namespace. A credential-free loopback
bridge at 127.0.0.1:45871 supports model, activity, context, conflict input, and
configured HTTP/SSE MCP routes. Caller authorization and proxy headers are
stripped; private headers are injected outside. Methods and paths are bounded,
redirects are not followed, configured queries cannot be replaced, and legacy
SSE endpoint URLs are rewritten to local handles. Direct external network
access remains unavailable. SEC-02 package/network policy remains deferred.

Every repository Git operation after agent execution uses the same isolated
boundary. A hostile Git filter therefore has workspace authority only. Bundle
creation finishes before a separate bounded nofollow reader receives upload
authority. The existing separate publisher performs verification and GitHub
publication. Bundle validation, expected-SHA leases, membership, ownership,
quota, gateway status, and cancellation gates remain authoritative.

Artifacts must be regular, single-link, bounded files with no symlink path
components. CLAUDE.md uses a bounded prefix read to retain previous truncation
behavior. Transcript archives accept regular files and directories only under
`.claude/projects`, `.codex/sessions`, or `.qwen/projects`; traversal, links,
special files, overwrite, more than 10,000 entries, and more than 64 MiB of
uncompressed content are refused. Restore checks parents before creating paths.

Cancellation signals the namespace supervisor rather than killing bubblewrap
immediately. Runners can flush their transcript; the bridge exits after at most
8 seconds and an outside 10-second deadline kills an unresponsive namespace.
Trusted artifact reads occur only after exit. Detached processes cannot remain
to race those reads. Existing task/history and resume semantics remain.

## Proof and limits

Run `npm test` with an unused `OPENFLOOR_E2E_PORT` if local port 8787 is occupied.
Broker tests use local HTTP servers to prove private environment separation,
streaming, route/query restrictions, redirects, malformed/truncated/multiline
SSE handling, and split UTF-8. Filesystem tests exercise real links, FIFOs,
bounded reads and hostile archives.

Build and test the exact deployment image:

```sh
docker build --platform linux/amd64 -f Dockerfile.sandbox -t openfloor-isolation:test .
docker run --rm --privileged --platform linux/amd64 --entrypoint /opt/openfloor/runtime-isolation-test.sh openfloor-isolation:test
```

The image gate tests native file access, outside process/file visibility, zero
capabilities, no_new_privs, network refusal, read-only replies, hostile Git
filters, real bridge/broker transport, cancellation flushing and descendant
termination. It also starts each pinned provider CLI. CLI startup and synthetic
transport tests do not prove a real model invocation or provider-specific tool
protocol. No live provider spend or deployment is part of these PRs.

This is a kernel namespace boundary within the executor container, with an
existing separate trusted publisher container. It is not a separate VM/kernel.
The outside broker is trusted code and remote server response bodies remain
untrusted; a remote server can echo a credential it received. A malicious task
can use its own allowed broker operations while the D1 run gate permits them,
and can corrupt its own transcript or outcome. User-submitted source,
attachments, prompts, and configured MCP tool results remain task-visible by
design. No claim of model-output truth or arbitrary kernel-exploit resistance
is made.

## Browser acceptance before rollout

Use the isolated development environment and disposable repository after an
explicitly authorized deployment. Repeat for every enabled provider (OpenAI,
Claude/Kimi, Gemini); disabled providers retain their independent live-key gate.

1. Create an agent, submit a small file edit, and confirm streamed activity,
   actual file content, publication, integration, and originating queue state.
2. Ask the agent to invoke the session-context tool and inspect an attachment;
   for Claude also exercise an imported skill and configured HTTP/SSE MCP tool.
3. Request reads of outside process environments, runtime scripts, and host
   files, plus a direct external network request. Confirm refusal while normal
   repository and scratch file operations work.
4. Submit a read-only question. Confirm no repository edits are permitted and
   final response is retained.
5. Cancel during work. Confirm bounded stop, retained transcript where the CLI
   flushes one, no later model spending, no publication, and no surviving work.
6. Retry a resumable run. Confirm thread continuity; a malformed transcript
   must safely fall back to a new thread rather than altering runtime settings.
7. Exercise a conflict resolver, request human input, choose a manual file
   resolution, then resume. Confirm context, snapshots, final verification,
   history, and expected-SHA publication remain correct.

The isolation hotfix introduced executor generation v11 and publisher v4.
Later image-content changes, including the preview namespace port, bump that
pool key; the live generation is recorded in `AGENTS.md`. No migrations or new
secrets/bindings are required. Rollback first disables new agent execution; do
not silently restore the weaker boundary while new runs continue. Rebuild with
a fresh image generation for any fix.

## Local validation record (2026-09-05)

`OPENFLOOR_E2E_PORT=8794 npm test` passed: 369 unit, 168 migration/D1,
85 worker, 49 render, and 13 browser tests (684 total), plus typecheck/lint.
The exact amd64 image gate passed on Docker Desktop, including all four CLI
startup checks. Image ID:
`sha256:732eb48c34af287fd7fc4d80686a6ae2eff87291d46d6237fbbef6d92a595fc5`.
These are local results; CI and live-provider acceptance are separate gates.

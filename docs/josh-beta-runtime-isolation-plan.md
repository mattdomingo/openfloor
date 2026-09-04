# Josh beta SEC-01: runtime boundary review and migration plan

Reviewed 2026-09-04 against `main` at `af50201`. Source: the user-approved
`docs/josh-beta-2026-09-04-codex-implementation-brief.md`, not the interview PDF.

## Outcome

SEC-01 is not complete. The repository already separates the final publisher
from agent execution, but that does not isolate every operation performed after
an agent has modified its workspace. This review changes no runtime behavior,
rollout flag, network policy, credential, or production resource.

The brief explicitly permits stopping at a migration plan when a safe incremental
architecture change is not established. That condition applies here: moving the
publisher again would duplicate an existing boundary, while changing only shell
identity would miss native provider file tools and trusted post-run Git.

## Existing flow and trust boundaries

1. The Worker reads authorized D1 run/session/repository state and signs bounded,
   operation-specific gateway tokens (`worker/agent-run-workflow.ts`,
   `lib/runtime-token.ts`). Long-lived provider keys, GitHub App private keys,
   encryption keys, and signing authority stay in the Worker.
2. A pooled execution Sandbox downloads a pinned source archive with a source
   token, creates a synthetic Git baseline, and receives the session brief,
   session files, optional skills, provider settings, and restored session store.
   The workflow records the run's Sandbox identity before preparation.
3. Provider CLIs run as `openfloor-provider`. They receive short-lived model,
   activity, context, and (when relevant) conflict-input authority. Claude remote
   MCP configuration additionally contains decrypted user-configured headers.
4. Model-selected shell commands cross the root-owned launcher and fixed srt /
   bubblewrap policy to `openfloor-workspace`. Provider homes are mode 0700;
   workspace environment credentials are cleared. The repository is writable by
   both identities through their shared group. Shell commands have no permitted
   external domains or Unix sockets (`lib/gemini-settings.ts`,
   `lib/claude-sandbox-settings.ts`, `scripts/runtime-identity.c`).
5. After the provider exits, the workflow invokes Git directly in that same
   mutable repository to inspect changes and export a bundle. Bundle export
   supplies a bundle-upload token to the command environment. The workflow also
   reads runner results and stores logs, diffs, and resumable provider state.
6. A distinct `publisher-*` Sandbox downloads the retained bundle with a read
   token. `scripts/publish-bundle.mjs` fetches an authoritative candidate using a
   repository-scoped GitHub installation token, validates the baseline, parent,
   ref set, paths, protected workflow paths, and object bounds, reconstructs the
   published commit, then pushes. It does not run repository tests or hooks.
7. Worker/GitHub integration uses authoritative SHAs and D1 leases. The publisher
   is destroyed; the execution Sandbox is reset before returning to its pool.
   Failed reset retires the pool entry.

The publisher is a separate container instance but uses the same image as the
executor. Root-owned runner, verifier, and cleanup scripts are present in that
image. No host bind mount is configured in this repository's production Sandbox
construction; that is not proof about undocumented platform-internal mounts.

## Confirmed gap: mutable Git configuration

`prepare exact workspace` makes the repository, including `.git`, group-writable.
Later collection invokes `git add -N .`; bundle export invokes
`git -c core.hooksPath=/dev/null add -A` and `commit` directly through Sandbox
execution rather than the workspace launcher. Disabling hooks does not disable
Git clean filters, textconv, external diff, or other executable Git configuration.

A disposable local reproduction on 2026-09-04 configured a clean filter, supplied
only a synthetic environment sentinel, and ran the workflow's `add` form. The
filter executed and inherited the sentinel despite hooks being disabled. This
proves the Git/environment mechanism, not a live Cloudflare exploit or actual
credential theft. No real credentials or user repository were used.

Reproduce locally with a temporary repository:

```python
import os, pathlib, subprocess, tempfile

with tempfile.TemporaryDirectory(prefix="openfloor-boundary-") as root:
    path = pathlib.Path(root)
    def git(*args, env=None):
        subprocess.run(["git", "-C", root, *args], check=True,
                       capture_output=True, env=env)
    git("init", "-q")
    (path / "example.txt").write_text("harmless content\n")
    (path / ".gitattributes").write_text("example.txt filter=probe\n")
    git("config", "filter.probe.clean",
        'sh -c \'printf "%s" "$OPENFLOOR_BOUNDARY_SENTINEL" > "$PWD/probe.txt"; cat\'')
    git("-c", "core.hooksPath=/dev/null", "add", "-A",
        env=dict(os.environ, OPENFLOOR_BOUNDARY_SENTINEL="synthetic-only"))
    assert (path / "probe.txt").read_text() == "synthetic-only"
```

## Additional gaps requiring proof

- The current adversarial image test covers shell identity transitions, provider
  home isolation, `/proc`, environment, capabilities, and raw launcher refusal.
  It does not exercise each provider's native Read/Write/Edit tools or hostile
  Git configuration during workflow collection/export.
- Claude enables native file tools in the provider process. Shell containment
  alone does not establish their filesystem boundary. Native file operations,
  symlink traversal, provider settings, and resumed state need provider-specific
  testing before claiming they cannot reach credential-bearing state.
- srt's `denyRead` is empty. Unix permissions protect private homes, but readable
  runtime scripts remain visible. Removing those scripts from the executor
  image requires defining which launcher/provider components must remain there.
- Required repository check commands are currently removed and preflight is
  gated off. Publication validates Git artifacts; it is not evidence that the
  changed application passes tests. Reintroducing checks must not execute them
  inside a credential-bearing verifier or publisher.

## Proposed incremental migration

These are proposed changes, not adopted production architecture.

1. **Define the complete execution boundary.** Treat repository text, config,
   provider-native file tools, child processes, and resumable state as untrusted.
   Keep Worker secrets and integration authority outside it. Prove the pinned
   providers' tool containment before choosing between an outer provider sandbox
   with a narrow credential broker and separate isolated tool execution. Do not
   claim shell-only wrappers protect native file tools.
2. **Close trusted post-run execution first.** Perform all Git work against
   agent-owned metadata inside the credential-free execution boundary. Stop all
   untrusted processes before artifact handoff. Transport a bounded immutable
   result through a trusted reader that rejects symlinks, special files, path
   traversal, excessive sizes, and concurrent replacement. Never pass upload
   credentials into a process that evaluates repository configuration. Validate
   the result independently before treating run metadata as authoritative.
3. **Separate image responsibilities.** Give the executor only runtime/tool
   components it needs. Put verification/publication/cleanup implementations and
   their configuration in a trusted image. Keep the existing fresh publisher
   instance, exact-SHA checks, protected paths, Git object bounds, and D1 leases.
   A trusted artifact verifier must not execute repository-controlled commands.
4. **Preserve supported functionality.** Adapt conflict reconstruction and human
   selections, logs/events, context MCP, user MCP/skills, cancellation, session
   files, thread resume, and pool reset to the new handoff. Persisted history and
   rollback attribution must remain readable. Keep checks/package policy out of
   this migration except to document their existing limits (SEC-02).
5. **Prove and roll out.** Add hostile Git/config/filter, symlink/artifact-race,
   background-process, native-file-tool, MCP-header, and session-store tests to
   the existing image gate. Run the full application pipeline. Bump the image
   pool key, deploy to isolated development only with authorization, and perform
   every enabled provider's disposable-repository acceptance before promotion.
   Keep execution disabled in the target environment if any isolation proof
   fails. Rollback must not reuse contaminated old pool entries.

Likely files/services: `Dockerfile.sandbox` and a trusted-image definition;
`worker/agent-run-workflow.ts`; `worker/index.ts` runtime artifact routes;
`scripts/*-runner.mjs`, `scripts/runner-env-preload.mjs`,
`scripts/runtime-identity.c`, `scripts/publish-bundle.mjs`;
`lib/gemini-settings.ts`, `lib/qwen-settings.ts`,
`lib/claude-sandbox-settings.ts`; `db/sandbox-pool.ts`; Wrangler Sandbox/image
bindings; `.github/workflows/deploy.yml`; runtime, publisher, and worker tests;
architecture, deployment, testing, and decision documentation. New persisted
handoff state, if required for Workflow retries, needs a separate schema review.

## Acceptance after implementation

Use only a disposable repository and synthetic sentinels. Across every enabled
provider, demonstrate that shell and native file tools cannot read secrets or
trusted verifier configuration, cannot mutate trusted code, and cannot carry
executable Git configuration into credential-bearing steps. Confirm ordinary
edits, file tools, retained history, conflict handling, cancellation, retry, and
publication still work. Restart at each durable handoff and confirm idempotency.
The present plan does not claim these acceptance checks have passed.

## Scope disposition

Batch A delivers the audit and migration plan only. SEC-01 implementation remains
open pending the complete provider/tool boundary design and proof. SEC-02 remains
a separate decision: current repository commands have no network egress; no
package-index allowlist or unrestricted installation capability is added here.
Ordinary application bugs and confirmed UI changes belong in separate PRs.

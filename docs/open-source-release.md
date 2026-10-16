# Public release preparation

This review covers the checked-out app and CLI source, their full locally available Git histories, and the CLI archive. It prepares source for review; repository visibility, tags, registry publication, and production deployment are separate actions.

## Prepared source

- Apache-2.0 LICENSE and NOTICE files, contribution and private security-reporting guidance, public package metadata, and dependency notices.
- A local app setup command that generates private development secrets without replacing existing configuration, with a container-free loopback workflow.
- Account-specific grant SQL and Sites project metadata removed from the current tree; personal workspace paths removed from current planning documents. Historical research briefs are labeled and retained.
- Current routing guidance uses the app's root path. CLI compatibility wording matches its checked-in contract fixture rather than claiming a newer unverified fixture revision.
- Checksum-pinned, redacted full-history Gitleaks scans in CI. CLI release archives are gated by the full macOS/Linux checks and installation smoke, include legal/security files, require matching version tags, and use release-only write permission.
- The manual deployment script uses pinned project dependencies and the same audit/test/artifact gates as the documented production workflow.

## Secret and privacy review

Gitleaks 8.30.1 was downloaded from its official release and verified against the release checksum. The app scan inspected 395 non-merge commits across all local refs (555 total commits including merges); the CLI scan inspected 29 non-merge commits (35 total). No actual credential was identified. Three app matches were reviewed: a clearly labeled synthetic Kimi plan-token fixture and two PEM marker strings enclosing JavaScript parser code. Only those exact historical fingerprints are listed in `.gitleaksignore`; other matches still fail CI. No file or test directory is broadly excluded.

These checks do not remove historical content. Earlier commits still contain the removed team email addresses, personal workspace path, and non-secret deployment metadata. Git commit authors and messages are also public when history is published. The maintainer chose to preserve existing history during this preparation. Deleting a current file does not erase its history, and no history was rewritten.

The checked-in domain and D1 UUID identify the hosted installation and are intentionally enforced by the artifact verifier. They are not credentials. A self-hosted fork must provision its own resources and update the exact configuration/verifier identity together.

## Release limitations

`AGENT_RUN_ENABLED` remains false because the same-user process-isolation issue is unresolved; public licensing does not imply that production agent execution is enabled or safe. See SECURITY.md and the historical security audits.

The Claude Agent SDK and provider executables use their upstream license/service terms. The project license covers openfloor source, not those components or provider trademarks. Review redistribution terms before publishing a built sandbox image.

## Dependency audit after compatible fixes

The app production dependency audit (`npm audit --omit=dev`) reports zero advisories after updating Next.js to 16.4.2, the MCP SDK to 1.32.1, and compatible transitive packages. Cloudflare Vite/Wrangler/types were updated together; no peer checks were disabled. The sandbox pins MCP SDK 1.32.1 and undici 7.29.1, with run-pool namespace v9. Global execution remains disabled.

The complete app development audit still reports 17 advisory entries (13 high, four moderate), down from 31 entries including two critical. They are development-tool dependency chains: `braces`/`micromatch`/`fast-glob` via vinext and eslint-config-next; the worker test pool's older Miniflare/sharp/undici/Wrangler; and drizzle-kit's legacy esbuild loaders. The CLI full dependency audit is clean after compatible transitive fixes. Current app upstream constraints do not provide a compatible clean resolution. npm proposes downgrades to vinext 0.0.15, eslint-config-next 14.2.35, the worker pool 0.8.30, and drizzle-kit 0.18.1; those were rejected. These remain release-review items, not a claim that every dependency is patched. Use the loopback dev server and isolated CI jobs; do not expose development servers publicly or provide production credentials to build/test jobs.

## Validation completed locally

- Frozen app dependency installation; type checking and lint (existing warnings only).
- App suites: 322 unit, 164 database/migration, 84 Worker/Durable Object, 45 rendering, and 11 browser tests passed (626 total).
- CLI type checking, lint, build, and 103 tests passed; its final tarball includes legal/security files and installs successfully against the local app.
- App production dependency audit and CLI complete dependency audit report zero advisories. The app full development audit retains the 17 entries described above.
- Gitleaks passes for proposed changes and for full history after the three exact historical false-positive fingerprints are reviewed. Workflow syntax passes actionlint.
- The sandbox Docker image builds with its digest-pinned base, supported proxy routing, a temporary CA secret, and TLS/package integrity checks enabled. The optional container runtime smoke could not run after the VFS image layers exhausted the local disk; generated image/cache artifacts were removed after recording the successful build. No provider execution or process-isolation acceptance is implied by an image build.
- The app starts through the public local setup commands; the CLI doctor reaches the authenticated API. Screenshots were captured from an isolated test server, and the production artifact was rebuilt and verified afterward.

## Maintainer publication steps

1. Review the source diff, history disclosures, dependency notices, and current validation results for both repositories.
2. Verify GitHub private vulnerability reporting, secret scanning/push protection, dependency alerts, and default-branch rules requiring the CI and secret-scan checks. The local environment cannot establish all of those GitHub settings. Repository metadata is readable and reports account admin access, but the installed integration denies visibility changes with HTTP 403 (Resource not accessible by integration).
3. The source-history policy is to preserve existing history. Confirm the intended repository visibility, then change visibility through GitHub when authorized. Update community/reporting links if the repositories are transferred.
4. For a CLI release, update the package version deliberately and follow its docs/release.md; only push a matching release tag after review. npm-registry publication is not configured.

The maintainer authorized pushing the completed changes and attempting public repository visibility. The visibility change was attempted through the GitHub API and denied by the integration; it still needs an administrator to change visibility in GitHub settings or grant the integration repository Administration write permission. No release tag or manual production deployment is part of this cleanup.

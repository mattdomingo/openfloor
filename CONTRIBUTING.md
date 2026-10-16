# Contributing to openfloor

Use issues for reproducible bugs and focused feature proposals. Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities; never include credentials, invite links, production data, or personal account details in public reports.

Read [AGENTS.md](AGENTS.md) before changing code. Keep changes focused, preserve existing user work, and update the engineering guide and relevant architecture/decision documentation when a durable contract changes. Do not commit local environment files, provider auth state, database contents, or generated build/test output.

## Development

Follow [README.md](README.md) for prerequisites and setup. Use `npm ci` with the committed lockfile. Production credentials are not required for the isolated automated tests.

Run `npm test` before handoff. It covers type checking, lint, unit, database, Worker, rendering, and browser tests. Install Playwright Chromium first. Browser tests overwrite `dist/` with a test build; follow them with `npm run build` and `npm run verify:deploy-artifact` if retaining a deployable artifact. See [testing strategy](docs/testing-strategy.md).

Never broaden loopback identity, enable test identity headers in a deployment, weaken concealed 404 responses, or enable the global agent execution gate while its process-isolation blocker remains. Changes involving providers or persisted schema need their corresponding runtime and migration coverage.

## Pull requests

Explain the user-visible problem, resulting behavior, and validation. Screenshots must use test data. Keep secrets and personal workspace paths out of descriptions and logs. Deployments, remote migrations, release tags, and repository visibility changes require explicit maintainer authorization.

Contributions are accepted under the repository's [Apache License 2.0](LICENSE). Preserve existing copyright notices and identify the source and license of any third-party material you add. Treat other contributors respectfully and keep feedback about the work.

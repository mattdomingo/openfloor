# Security policy

## Reporting a vulnerability

Report privately through [GitHub private vulnerability reporting](https://github.com/mattdomingo/openfloor/security/advisories/new). If GitHub does not offer that form, ask a maintainer through the contact method on their GitHub profile for a private channel before sending details. Do not open a public issue with exploit details, credentials, session content, or invite links.

Include the affected commit/version, reproduction steps using disposable test data, impact, and any proposed fix. Redact keys, cookies, JWTs, private repository data, and user information. Do not test against other users or the hosted service without permission.

## Supported code

Security fixes target the default branch. Older releases do not have a separate support commitment. Dependency advisories and GitHub settings must be reviewed again before each public release.

## Current execution limitation

`AGENT_RUN_ENABLED` must remain `false`. Provider CLIs and repository-controlled commands currently share a Linux user, so same-user `/proc` reads can expose a CLI's initial gateway token. Environment-variable filtering does not resolve this. A separate-user or equivalent isolation boundary and adversarial container proof are prerequisites to enabling agent execution. See [known limitations](docs/known-limitations.md) and the historical security audits in `docs/`.

Local development identity is restricted to loopback hosts. Test identity headers belong only in the isolated test harnesses. Production artifacts must pass `npm run verify:deploy-artifact` before deployment. Public Wrangler resource identifiers are not authentication credentials; access still requires the owner's Cloudflare configuration.

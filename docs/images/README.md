# Screenshot provenance

`agent-floor-light.png`, `agent-floor-dark.png`, and `sessions-light.png` were captured with Playwright from the real app on 2026-10-16, using `tests/e2e/server.mjs` and its isolated temporary D1 database and test-only GitHub fixture. Alex Example and Jordan Example are disposable test identities, not customer accounts. Agents, messages, and queued prompts were created through the application's normal authenticated APIs. Auto-dispatch was off; no provider run or live GitHub integration is implied.

The screenshots show the actual Light and Dark themes at a 1440 × 1000 viewport; they were not composited or altered. The earlier `review-prompts.png` comes from the repository's isolated two-user review test scenario.

For new screenshots, run the isolated E2E server on its own loopback port, use disposable accounts through the test harness, and capture the rendered page with Playwright. Keep test identity headers confined to that harness, close the server afterward, and rebuild/verify the production artifact because the harness overwrites dist/. Do not capture real invite links, credentials, personal account details, or private repository content.

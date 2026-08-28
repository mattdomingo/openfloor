import { expect, test } from "@playwright/test";
import { authenticatedContext } from "./fixtures";

// Reproduces the reported bug end to end, through the real browser and
// worker: a user signs in once (simulating a one-time-code login), creates
// a session, then returns later through a *different* login method — same
// mailbox, different case, a provider id the account has never seen before
// (exactly what Cloudflare Access presents for a Google login vs. an
// email-code login; see lib/identity.ts and db/sessions.ts:upsertUser).
// Before the fix, the second login silently created a second, empty
// account and the session page 404'd with a bare "Not Found". Assertions
// check the rendered page, not just the HTTP status, so a 200 error page
// can't pass this test by accident.
test("returning through a different login method reaches the same session, not a fresh empty account", async ({ browser }) => {
  const firstLoginContext = await authenticatedContext(browser, "otp-login", "return-bug@example.com", "Returning", "Owner");
  const firstLogin = await firstLoginContext.newPage();

  await firstLogin.goto("/home");
  await firstLogin.getByRole("button", { name: "New session" }).click();
  await firstLogin.getByLabel("Task").fill("Session from the first login");
  await expect(firstLogin.getByLabel("Candidate branch name")).toHaveValue("Session from the first login");
  await firstLogin.getByRole("button", { name: "Create session" }).click();
  // A ready provision lands on the agent floor; the lobby URL (what the
  // rest of this test cares about) is that with /floor stripped.
  await expect(firstLogin).toHaveURL(/\/session\/[0-9a-f-]+\/floor$/);
  const sessionUrl = firstLogin.url().replace(/\/floor$/, "");
  await firstLoginContext.close();

  // Same mailbox, different case, different provider id — the Google-login
  // shape. authenticatedContext's onboarding POST is itself the first
  // request this identity ever makes, exactly mirroring a real return visit.
  const googleLoginContext = await authenticatedContext(browser, "google-login", "Return-Bug@Example.com", "Returning", "Owner");
  const googleLogin = await googleLoginContext.newPage();

  await googleLogin.goto(sessionUrl);
  await expect(googleLogin.getByRole("heading", { name: "Session from the first login" })).toBeVisible();
  await expect(googleLogin.getByText("Not Found")).toHaveCount(0);

  await googleLoginContext.close();
});

test("a genuine stranger with a different email still cannot open the session", async ({ browser }) => {
  const ownerContext = await authenticatedContext(browser, "stranger-test-owner", "stranger-test-owner@example.com", "Owner", "Example");
  const owner = await ownerContext.newPage();
  await owner.goto("/home");
  await owner.getByRole("button", { name: "New session" }).click();
  await owner.getByLabel("Task").fill("Private to the owner");
  await expect(owner.getByLabel("Candidate branch name")).toHaveValue("Private to the owner");
  await owner.getByRole("button", { name: "Create session" }).click();
  await expect(owner).toHaveURL(/\/session\/[0-9a-f-]+\/floor$/);
  const sessionUrl = owner.url().replace(/\/floor$/, "");
  await ownerContext.close();

  const strangerContext = await authenticatedContext(browser, "stranger-test-outsider", "stranger-test-outsider@example.com", "Outsider", "Example");
  const stranger = await strangerContext.newPage();
  const response = await stranger.goto(sessionUrl);
  expect(response?.status()).toBe(404);
  await strangerContext.close();
});

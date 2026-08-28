import { expect, test } from "@playwright/test";
import { authenticatedContext, identityHeaders } from "./fixtures";

test("a direct user keeps profile state across steps and completes Free onboarding", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: identityHeaders("onboarding-direct", "onboarding-direct@example.com", "Direct Person"),
  });
  const page = await context.newPage();

  await page.goto("/onboarding?return_to=%2Fhome");
  await page.getByLabel("First name").fill("");
  await page.getByLabel("Last name").fill("");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter your first and last name to continue.");
  await page.getByLabel("First name").fill("Ada");
  await page.getByLabel("Last name").fill("Lovelace");

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => page.locator(".field-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);

  // GitHub lives on the profile step now — Continue refuses until it's
  // connected, then the device-flow dialog links the fake installation.
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Connect GitHub to continue.");
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  // ENG-163: Connect GitHub runs the device-flow dialog now; test mode links
  // the fake installation on the first poll, then Done dismisses the modal.
  await expect(page.getByText("Connected. openfloor can reach:")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("GitHub access connected.")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect AI providers" })).toBeFocused();
  await expect(page.getByText("Anthropic")).toBeVisible();

  // Back keeps the saved profile state.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("First name")).toHaveValue("Ada");
  await expect(page.getByLabel("Last name")).toHaveValue("Lovelace");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect.poll(() => page.locator(".onboarding-plan-actions:visible").evaluate((element) => getComputedStyle(element).flexDirection)).toBe("column-reverse");
  // No plan step — Finish enrolls the account on Free.
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/home$/);

  // This context never set the tour's seen-it flag, so the first-visit
  // guided tour opens on /home. It advances only by clicking the
  // highlighted element itself (GuidedTour.tsx): the tabs first, then the
  // New session tile — whose click both ends the tour and opens the
  // one-page create dialog.
  const tour = page.getByRole("dialog", { name: "Your sessions" });
  await expect(tour).toBeVisible();
  await expect(tour.getByRole("button", { name: "Next" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Active/ }).click();
  await expect(page.getByRole("dialog", { name: "Start a session" })).toBeVisible();
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByRole("heading", { name: "Name the session" })).toBeVisible();
  // The tour follows into the create dialog: its last step anchors the
  // Create submit, and only a real create — or Skip — ends it.
  await expect(page.getByRole("dialog", { name: "Name it, pick a repository, create" })).toBeVisible();
  // The whole create form is one page: task, repository, branch, and the
  // AI connection are all present with a single Create submit.
  await expect(page.getByLabel("Task")).toBeVisible();
  await expect(page.getByLabel("Candidate branch name")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create session" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.locator(".tour-bubble")).toHaveCount(0);

  await context.close();
});

test("leaving onboarding via the back button signs the person out", async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: identityHeaders("onboarding-back-exit", "onboarding-back-exit@example.com", "Back Exit"),
  });
  const page = await context.newPage();

  await page.goto("/onboarding?return_to=%2Fhome");
  await expect(page.getByRole("heading", { name: "Create your profile" })).toBeVisible();
  await page.goBack();
  // /signout has no team domain configured in the test server, so it 302s
  // straight to the landing page rather than running its team-logout script.
  await expect(page).toHaveURL(/\/$/);

  await context.close();
});

test("the back-button exit stays armed after a step change", async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: identityHeaders("onboarding-back-exit-step2", "onboarding-back-exit-step2@example.com", "Back Exit Two"),
  });
  const page = await context.newPage();

  await page.goto("/onboarding?return_to=%2Fhome");
  await page.getByLabel("First name").fill("Grace");
  await page.getByLabel("Last name").fill("Hopper");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Connect GitHub to continue.");
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  await expect(page.getByText("Connected. openfloor can reach:")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect AI providers" })).toBeFocused();

  // changeStep uses history.replaceState (not router.replace), which must
  // not consume the exit-trap's sentinel history entry.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);

  await context.close();
});

test("a valid invite completes Free onboarding and still requires explicit membership", async ({ browser }) => {
  const ownerContext = await authenticatedContext(browser, "onboarding-invite-owner", "onboarding-invite-owner@example.com", "Invite", "Owner");
  const repositories = await (await ownerContext.request.get("/api/account/github/repositories")).json() as {
    repositories: Array<{ id: string; accountInstallationId: string }>;
  };
  const created = await ownerContext.request.post("/api/sessions", {
    data: {
      title: "Onboarding invite room",
      repositoryId: repositories.repositories[0].id,
      accountInstallationId: repositories.repositories[0].accountInstallationId,
    },
  });
  expect(created.ok()).toBe(true);
  const payload = await created.json() as { inviteUrl: string };
  const invitePath = new URL(payload.inviteUrl).pathname;

  const inviteeContext = await browser.newContext({ extraHTTPHeaders: identityHeaders("onboarding-invitee", "onboarding-invitee@example.com", "Invite New") });
  const invitee = await inviteeContext.newPage();
  await invitee.goto(invitePath);
  await expect(invitee).toHaveURL(/\/onboarding\?return_to=/);
  await invitee.getByRole("button", { name: "Connect GitHub" }).click();
  await expect(invitee.getByText("Connected. openfloor can reach:")).toBeVisible();
  await invitee.getByRole("button", { name: "Done" }).click();
  await invitee.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(invitee.getByRole("heading", { name: "Connect AI providers" })).toBeFocused();
  await invitee.getByRole("button", { name: "Finish setup" }).click();
  await expect(invitee).toHaveURL(invitePath);
  await expect(invitee.getByRole("button", { name: "Join session" })).toBeVisible();

  await ownerContext.close();
  await inviteeContext.close();
});

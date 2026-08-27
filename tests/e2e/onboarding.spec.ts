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

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect GitHub" })).toBeFocused();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("First name")).toHaveValue("Ada");
  await expect(page.getByLabel("Last name")).toHaveValue("Lovelace");

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  // ENG-163: Connect GitHub runs the device-flow dialog now; test mode links
  // the fake installation on the first poll, then Done dismisses the modal.
  await expect(page.getByText("Connected. openfloor can reach:")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("GitHub access connected.")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect AI providers" })).toBeFocused();
  await expect(page.getByText("Anthropic")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /^Free/ }).click();
  await expect.poll(() => page.locator(".onboarding-plan-actions:visible").evaluate((element) => getComputedStyle(element).flexDirection)).toBe("column-reverse");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/home$/);

  await context.close();
});

test("paid plan selection exposes seat controls bounded by its catalog", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: identityHeaders("onboarding-paid", "onboarding-paid@example.com", "Paid Person") });
  const page = await context.newPage();

  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  await expect(page.getByText("Connected. openfloor can reach:")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /^Pro/ }).click();
  await expect(page.getByText("Seats per session: 3")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove one seat" })).toBeDisabled();
  await page.getByRole("button", { name: "Add one seat" }).click();
  await page.getByRole("button", { name: "Add one seat" }).click();
  await expect(page.getByText("Seats per session: 5")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add one seat" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Continue to payment" })).toBeEnabled();

  await context.close();
});

test("a valid invite locks onboarding to Free and still requires explicit membership", async ({ browser }) => {
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
  await invitee.getByRole("button", { name: "Continue", exact: true }).click();
  await invitee.getByRole("button", { name: "Connect GitHub" }).click();
  await expect(invitee.getByText("Connected. openfloor can reach:")).toBeVisible();
  await invitee.getByRole("button", { name: "Done" }).click();
  await invitee.getByRole("button", { name: "Continue", exact: true }).click();
  await invitee.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(invitee.getByRole("heading", { name: "Your invite includes Free" })).toBeFocused();
  await expect(invitee.getByText("This invite includes a Free openfloor account.")).toBeVisible();
  await expect(invitee.getByRole("button", { name: /^Pro/ })).toHaveCount(0);
  await invitee.getByRole("button", { name: "Finish setup" }).click();
  await expect(invitee).toHaveURL(invitePath);
  await expect(invitee.getByRole("button", { name: "Join session" })).toBeVisible();

  await ownerContext.close();
  await inviteeContext.close();
});

import { expect, test } from "@playwright/test";
import { authenticatedContext } from "./fixtures";

test("tutorial recovers detours and closed setup, and never completes failed creation", async ({ browser }) => {
  const context = await authenticatedContext(browser, "friendly-tour", "friendly-tour@example.com", "Tour", "Tester");
  await context.addInitScript(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("openfloor:tutorial:home:")) localStorage.removeItem(key);
  });
  const page = await context.newPage();
  await page.goto("/home");
  for (const tab of ["Archived", "Ended", "Usage"]) {
    await page.getByRole("button", { name: new RegExp(`^${tab}`) }).click();
    await page.getByRole("dialog", { name: "Return to Active" }).getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("dialog", { name: "Your sessions" })).toBeVisible();
  }
  await page.getByRole("dialog", { name: "Your sessions" }).getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "Start a session" }).getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Name the task" }).getByRole("button", { name: "Next" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Reopen session setup" }).getByRole("button", { name: "Next" }).click();
  await page.getByLabel("Task", { exact: true }).fill("Failed creation stays open");
  await page.getByRole("dialog", { name: "Name the task" }).getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "Say what done looks like" }).getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "Pick the repository" }).getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "Name the candidate branch" }).getByRole("button", { name: "Next" }).click();
  await page.getByRole("dialog", { name: "Check your AI is connected" }).getByRole("button", { name: "Next" }).click();
  await page.route("**/api/sessions", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Creation failed for acceptance test" }) }));
  await page.getByRole("dialog", { name: "Create the session" }).getByRole("button", { name: "Create session" }).click();
  await expect(page.getByRole("alert")).toContainText("Creation failed for acceptance test");
  await expect(page.getByRole("dialog", { name: "Create the session" })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("openfloor:tutorial:home:")).length)).toBe(0);
  await context.close();
});

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`landing idle hint respects ${reducedMotion}`, async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion });
    const page = await context.newPage();
    await page.clock.install();
    await page.goto("/");
    const entry = page.locator(".entry-signin");
    await expect(entry).not.toHaveAttribute("data-idle");
    await page.clock.fastForward(10_100);
    await expect(entry).toHaveAttribute("data-idle", "true");
    if (reducedMotion === "reduce") expect(await entry.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await page.mouse.move(100, 100);
    await expect(entry).not.toHaveAttribute("data-idle");
    await context.close();
  });
}

import { expect, test } from "@playwright/test";
import { authenticatedContext } from "./fixtures";

test("monthly provider limits show a dollar prefix", async ({ browser }) => {
  const context = await authenticatedContext(
    browser,
    "provider-limit-prefix",
    "provider-limit-prefix@example.com",
    "Budget",
    "Owner",
  );
  const connected = await context.request.put("/api/account/credentials/anthropic", {
    data: { apiKey: "sk-ant-e2e-accepted" },
  });
  expect(connected.ok()).toBe(true);

  const page = await context.newPage();
  await page.goto("/home/settings?section=connections");
  const row = page.locator(".provider-credential-row").filter({ hasText: "Anthropic" }).first();
  await row.getByRole("button", { name: /Anthropic/ }).click();
  await row.getByRole("button", { name: "Set limit" }).click();

  const limit = row.locator(".currency-input");
  await expect(limit.locator(":scope > span")).toHaveText("$");
  await expect(limit.getByLabel("Monthly limit in US dollars")).toBeVisible();

  await context.close();
});

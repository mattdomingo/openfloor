import { expect, test } from "@playwright/test";
import { identityHeaders } from "./fixtures";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("Choose picture opens the file chooser and the cropper", async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: identityHeaders("avatar-pick", "avatar-pick@example.com", "Avatar Picker"),
  });
  const page = await context.newPage();
  await page.goto("/onboarding?return_to=%2Fhome");

  const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
  await page.getByRole("button", { name: "Choose picture" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "avatar.png", mimeType: "image/png", buffer: PNG_1X1 });

  await expect(page.getByRole("button", { name: "Use picture" })).toBeVisible();
  await page.getByRole("button", { name: "Use picture" }).click();
  await expect(page.getByRole("button", { name: "Change picture" })).toBeVisible();
});

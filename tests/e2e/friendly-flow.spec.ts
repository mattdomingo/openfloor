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

test("lobby shows joined avatars, accessible controls and complete empty Review", async ({ browser }) => {
  const owner = await authenticatedContext(browser, "friendly-lobby-owner", "friendly-lobby-owner@example.com", "Lobby", "Owner");
  const member = await authenticatedContext(browser, "friendly-lobby-member", "friendly-lobby-member@example.com", "Lobby", "Member");
  const avatar = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  for (const [context, lastName] of [[owner, "Owner"], [member, "Member"]] as const) {
    const uploaded = await context.request.patch("/api/account/profile", { multipart: { firstName: "Lobby", lastName, githubHandle: "", avatar: { name: "avatar.png", mimeType: "image/png", buffer: avatar } } });
    expect(uploaded.ok()).toBe(true);
  }
  const repositories = await (await owner.request.get("/api/account/github/repositories")).json();
  const repository = repositories.repositories[0];
  const created = await owner.request.post("/api/sessions", { data: { title: "Friendly lobby", repositoryId: repository.id, accountInstallationId: repository.accountInstallationId } });
  expect(created.status()).toBe(201);
  const { session, inviteUrl } = await created.json();
  const page = await owner.newPage();
  await page.goto(`/session/${session.id}`);
  await expect(page.getByRole("button", { name: /Prepare the workspace/ })).toHaveAttribute("aria-expanded", "false");
  const joined = await member.newPage();
  await joined.goto(new URL(inviteUrl).pathname);
  await joined.getByRole("button", { name: "Join session" }).click();
  await expect(page.locator(".member-panel .member-list img")).toHaveCount(2);
  await expect.poll(() => page.locator(".member-panel .member-list img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.locator(".member-panel").getByText(/Joined/)).toHaveCount(0);
  await page.getByRole("button", { name: "Copy link", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Copy");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "Enter agent floor" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: /Prepare the workspace/ }).click();
  await expect(page.getByRole("button", { name: /Prepare the workspace/ })).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "Enter agent floor" }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No review available" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prompts", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Squash merge", exact: true })).toBeDisabled();
  await expect(page.getByText("No checks available", { exact: true })).toBeVisible();
  for (let index = 0; index < 26; index++) expect((await owner.request.post(`/api/sessions/${session.id}/queue`, { data: { prompt: `Retained prompt ${index}`, agentId: null } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Prompts", exact: true }).click();
  await expect(page.locator(".review-prompt-item")).toHaveCount(25);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.locator(".review-prompt-item")).toHaveCount(26);
  await expect(page.getByText("This prompt has not produced a run.")).toBeVisible();
  await owner.close();
  await member.close();
});

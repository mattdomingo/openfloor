import { expect, test, type Browser, type BrowserContext } from "@playwright/test";

function identityHeaders(id: string, email: string, name: string) {
  return {
    "x-openfloor-dev-user-id": id,
    "x-openfloor-dev-user-email": email,
    "x-openfloor-dev-user-name": name,
  };
}

async function authenticatedContext(browser: Browser, id: string, email: string, name: string): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: identityHeaders(id, email, name) });
}

test("owner and member persist, share live presence, reconnect, and leave", async ({ browser }) => {
  const ownerContext = await authenticatedContext(browser, "owner-e2e", "owner@example.com", "Owner Example");
  const memberContext = await authenticatedContext(browser, "member-e2e", "member@example.com", "Member Example");
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  await owner.goto("/app/home");
  await owner.getByRole("button", { name: "New session" }).click();
  await owner.getByLabel("Session title").fill("Release coordination");
  await owner.getByLabel(/Objective/).fill("Ship persistent multiplayer sessions");
  await owner.getByRole("button", { name: "Create session" }).click();
  await expect(owner).toHaveURL(/\/app\/session\/[0-9a-f-]+$/);
  await expect(owner.getByText("Owner Example").first()).toBeVisible();
  await expect(owner.getByText("Online", { exact: true })).toBeVisible();

  const inviteUrl = await owner.getByLabel("Active invite link").inputValue();
  expect(inviteUrl).toContain("/app/join/");

  await member.goto(new URL(inviteUrl).pathname);
  await expect(member.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(member.getByText("Owner Example")).toBeVisible();
  await member.getByRole("button", { name: "Join session" }).click();
  await expect(member).toHaveURL(/\/app\/session\/[0-9a-f-]+$/);

  await expect(owner.getByText("Member Example")).toBeVisible();
  await expect(owner.locator("li", { hasText: "Member Example" }).getByText("Online", { exact: true })).toBeVisible();
  await expect(member.locator("li", { hasText: "Owner Example" }).getByText("Online", { exact: true })).toBeVisible();

  await owner.getByRole("link", { name: "Enter agent floor" }).click();
  await expect(owner).toHaveURL(/\/app\/session\/[0-9a-f-]+\/floor$/);
  await expect(owner.getByRole("heading", { name: "Agent floor" })).toBeVisible();
  await expect(owner.locator("li", { hasText: "Member Example" })).toBeVisible();
  await expect(owner.locator("li", { hasText: "Member Example" }).getByLabel("Online")).toBeVisible();
  await owner.getByRole("link", { name: "Session settings" }).click();

  await member.reload();
  await expect(member.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(member.getByText("Ship persistent multiplayer sessions")).toBeVisible();

  await member.close();
  await expect(owner.locator("li", { hasText: "Member Example" }).getByText("Offline", { exact: true })).toBeVisible();

  const reconnectedMember = await memberContext.newPage();
  await reconnectedMember.goto(owner.url());
  await expect(owner.locator("li", { hasText: "Member Example" }).getByText("Online", { exact: true })).toBeVisible();
  await reconnectedMember.getByRole("button", { name: "Leave session" }).click();
  await expect(reconnectedMember).toHaveURL(/\/app\/home$/);
  await expect(owner.getByText("Member Example")).toHaveCount(0);

  await owner.reload();
  await expect(owner.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(owner.getByText("1 online")).toBeVisible();

  await ownerContext.close();
  await memberContext.close();
});

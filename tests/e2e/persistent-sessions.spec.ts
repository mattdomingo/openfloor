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
  const pageErrors: string[] = [];
  owner.on("pageerror", (error) => pageErrors.push(error.message));

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
  await member.getByRole("link", { name: "Enter agent floor" }).click();
  await expect(owner).toHaveURL(/\/app\/session\/[0-9a-f-]+\/floor$/);
  await expect(owner.getByRole("heading", { name: "Agent floor" })).toBeVisible();
  await expect(owner.getByText("Member Example").first()).toBeVisible();
  await expect(owner.getByText("No agents yet")).toBeVisible();
  await expect(owner.getByText("No prompts waiting")).toBeVisible();
  await expect(owner.getByText("No review available")).toHaveCount(0);
  await expect(owner.getByText(/Atlas|Nova|Sentry|Proof|OpenMind/)).toHaveCount(0);

  await owner.getByTitle("Edit session objective").click();
  await owner.getByLabel("Session objective").fill("Coordinate the restored agent floor");
  await owner.getByLabel("Session objective").blur();
  await expect(member.getByTitle("Edit session objective")).toHaveText("Coordinate the restored agent floor");

  await owner.getByRole("button", { name: "Invite" }).click();
  await expect(owner.getByLabel("Session invite link")).toHaveValue(/\/app\/join\//);
  await owner.getByRole("button", { name: "Done" }).click();

  const agentFloor = owner.getByRole("region", { name: "Agent floor" });
  await agentFloor.getByRole("button", { name: "New agent" }).click();
  await owner.getByLabel("Name").fill("Lumen");
  await owner.getByLabel("Role").fill("Researcher");
  await owner.getByLabel("Task").fill("Map the persistent agent API");
  await owner.getByRole("dialog").getByRole("button", { name: "Create agent" }).click();
  await expect(owner.getByRole("dialog")).toBeHidden();
  await expect(agentFloor.getByText("Lumen", { exact: true }).first()).toBeVisible();
  await expect(member.getByText("Lumen", { exact: true }).first()).toBeVisible();
  await expect(agentFloor.getByText(/server\/|app\/|tests\//)).toHaveCount(0);

  await owner.getByLabel("Prompt to add to the queue").fill("Document the next backend contract");
  await expect(owner.getByLabel("Prompt to add to the queue")).toHaveValue("Document the next backend contract");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  expect(pageErrors).toEqual([]);
  await expect(owner.getByText("Document the next backend contract")).toBeVisible();
  await expect(owner.getByText("Unassigned", { exact: true }).first()).toBeVisible();
  await expect(member.getByText("Document the next backend contract")).toBeVisible();

  await owner.getByLabel("Queue target").selectOption({ label: "Lumen" });
  await owner.getByLabel("Prompt to add to the queue").fill("Inspect the real session contract");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  await expect(owner.getByText("Inspect the real session contract")).toBeVisible();
  await expect(member.getByText("Inspect the real session contract")).toBeVisible();
  await owner.getByLabel("Prompt to add to the queue").fill("Confirm the persisted contract");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  await owner.getByLabel("Queue settings").click();
  await owner.getByRole("button", { name: /Merge now/ }).click();
  await expect(owner.getByText("2 prompts", { exact: true })).toBeVisible();

  const teamPanel = owner.getByRole("region", { name: "Team" });
  await teamPanel.getByRole("button", { name: "Chat" }).click();
  await teamPanel.getByLabel("Message the team").fill("The persistent floor is ready");
  await teamPanel.getByRole("button", { name: "Send message" }).click();
  await expect(teamPanel.getByText("The persistent floor is ready")).toBeVisible();
  const memberTeamPanel = member.getByRole("region", { name: "Team" });
  await memberTeamPanel.getByRole("button", { name: "Chat" }).click();
  await expect(memberTeamPanel.getByText("The persistent floor is ready")).toBeVisible();

  await teamPanel.getByRole("button", { name: "Member Example" }).click();
  await teamPanel.getByLabel("Message Member Example").fill("Private persisted note");
  await teamPanel.getByRole("button", { name: "Send message" }).click();
  await memberTeamPanel.getByRole("button", { name: "Owner Example" }).click();
  await expect(memberTeamPanel.getByText("Private persisted note")).toBeVisible();

  await teamPanel.getByRole("button", { name: "Goals" }).click();
  await teamPanel.getByLabel("Assignment for Owner Example").fill("Own the persistent release");
  await teamPanel.getByLabel("Assignment for Owner Example").blur();
  await memberTeamPanel.getByRole("button", { name: "Goals" }).click();
  await expect(memberTeamPanel.getByLabel("Assignment for Owner Example")).toHaveValue("Own the persistent release");

  await owner.getByRole("button", { name: "Review" }).click();
  await expect(owner.getByRole("heading", { name: "No review available" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Approve candidate" })).toHaveCount(0);
  await expect(owner.getByText(/server\/session\/reducer|AgentCard\.tsx/)).toHaveCount(0);
  await expect(owner.getByText(/typing/i)).toHaveCount(0);
  await expect(owner.getByText(/terminal/i)).toHaveCount(0);

  await member.reload();
  await expect(member.getByText("Lumen", { exact: true }).first()).toBeVisible();
  await expect(member.getByText("Document the next backend contract")).toBeVisible();

  await owner.getByRole("link", { name: "Session settings" }).click();
  await member.getByRole("link", { name: "Session settings" }).click();
  await expect(owner).toHaveURL(/\/app\/session\/[0-9a-f-]+$/);
  await expect(member).toHaveURL(/\/app\/session\/[0-9a-f-]+$/);

  await member.reload();
  await expect(member.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(member.getByText("Coordinate the restored agent floor")).toBeVisible();

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

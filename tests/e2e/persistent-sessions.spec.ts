import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { authenticatedContext } from "./fixtures";

test("owner and member persist, share live presence, reconnect, and leave", async ({ browser }) => {
  const ownerContext = await authenticatedContext(browser, "owner-e2e", "owner@example.com", "Owner", "Example");
  const memberContext = await authenticatedContext(browser, "member-e2e", "member@example.com", "Member", "Example");
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const pageErrors: string[] = [];
  owner.on("pageerror", (error) => pageErrors.push(error.message));

  const webhookPayload = JSON.stringify({ zen: "phase-one" });
  const webhookSignature = createHmac("sha256", "e2e-test-github-webhook-secret").update(webhookPayload).digest("hex");
  const rejectedWebhook = await owner.request.post("/app/webhooks/github", {
    data: webhookPayload,
    headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": "sha256=invalid" },
  });
  expect(rejectedWebhook.status()).toBe(401);
  const acceptedWebhook = await owner.request.post("/app/webhooks/github", {
    data: webhookPayload,
    headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": `sha256=${webhookSignature}` },
  });
  expect(acceptedWebhook.status()).toBe(200);

  await owner.goto("/app/home");
  await owner.getByRole("button", { name: "New session" }).click();
  await owner.getByLabel("Session title").fill("Release coordination");
  await owner.getByLabel(/Objective/).fill("Ship persistent multiplayer sessions");
  await owner.getByRole("button", { name: "Create session" }).click();
  await expect(owner).toHaveURL(/\/app\/session\/[0-9a-f-]+$/);
  await expect(owner.getByText("Owner E.").first()).toBeVisible();
  await expect(owner.getByText("Online", { exact: true })).toBeVisible();

  const inviteUrl = await owner.getByLabel("Active invite link").inputValue();
  expect(inviteUrl).toContain("/app/join/");

  await member.goto(new URL(inviteUrl).pathname);
  await expect(member.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(member.getByText("Owner E.")).toBeVisible();
  await member.getByRole("button", { name: "Join session" }).click();
  await expect(member).toHaveURL(/\/app\/session\/[0-9a-f-]+$/);

  await expect(owner.getByText("Member E.")).toBeVisible();
  await expect(owner.locator("li", { hasText: "Member E." }).getByText("Online", { exact: true })).toBeVisible();
  await expect(member.locator("li", { hasText: "Owner E." }).getByText("Online", { exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Connect GitHub" }).click();
  await expect(owner.getByRole("combobox", { name: "Connected repository" })).toContainText("openfloor-test/repository-integration");
  await expect(owner.getByRole("combobox", { name: "Repository base branch" })).toContainText("main");
  await owner.getByRole("button", { name: "Save repository" }).click();
  await expect(owner.getByText("openfloor-test/repository-integration")).toBeVisible();
  await expect(owner.getByText("Not configured", { exact: true })).toBeVisible();
  await member.reload();
  await expect(member.getByText("openfloor-test/repository-integration")).toBeVisible();
  await expect(member.getByText("Not configured", { exact: true })).toBeVisible();
  await expect(member.getByRole("button", { name: "Configure" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Disconnect" })).toHaveCount(0);

  await owner.getByRole("button", { name: "Configure" }).click();
  await owner.getByLabel("Required check commands").fill("npm test\nnpm run build");
  await owner.getByRole("button", { name: "Save repository" }).click();
  await expect(owner.getByText("npm test", { exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Disconnect" }).click();
  await expect(owner.getByText("Disconnected", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Reconnect GitHub" }).click();
  await expect(owner.getByRole("combobox", { name: "Connected repository" })).toContainText("openfloor-test/repository-integration");
  await owner.getByLabel("Required check commands").fill("npm test");
  await owner.getByRole("button", { name: "Save repository" }).click();
  await expect(owner.getByText("Connected", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Enable execution" }).click();
  await expect(owner.getByLabel("Candidate branch name")).toHaveValue("Release coordination");
  await expect(owner.getByLabel("Candidate description")).toHaveValue("Ship persistent multiplayer sessions");
  await owner.getByLabel("Candidate branch name").fill("Release candidate");
  await owner.getByLabel("Candidate description").fill("Integrate the repository execution release.");
  await owner.getByRole("button", { name: "Create candidate" }).click();
  await expect(owner.getByText("Execution enabled. Candidate branch created.")).toBeVisible();
  await expect(owner.getByText("Release candidate", { exact: true })).toBeVisible();
  await expect(owner.getByText("Integrate the repository execution release.", { exact: true })).toBeVisible();
  await expect(owner.getByText(/openfloor\/[0-9a-f]{8}\/candidate\/release-candidate-[0-9a-f]{8}/)).toBeVisible();
  await expect(owner.getByText("Ready", { exact: true })).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("button", { name: "Sync repository" })).toBeVisible();
  await owner.getByRole("button", { name: "Sync repository" }).click();
  await expect(owner.getByText("Ready", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Verify runner" }).click();
  await expect(owner.getByLabel("Runner verification").getByText("passed", { exact: true }).first()).toBeVisible();
  await owner.getByRole("button", { name: "Open command output" }).click();
  await expect(owner.getByText("preflight check passed", { exact: false })).toBeVisible();
  await owner.reload();
  await expect(owner.getByLabel("Runner verification").getByText("passed", { exact: true }).first()).toBeVisible();
  await owner.getByRole("button", { name: "Configure" }).click();
  await owner.getByLabel("Required check commands").fill("false");
  await owner.getByRole("button", { name: "Save repository" }).click();
  await owner.getByRole("button", { name: "Verify runner" }).click();
  await expect(owner.getByLabel("Runner verification").getByText("failed", { exact: true }).first()).toBeVisible();
  await owner.getByRole("button", { name: "Configure" }).click();
  await owner.getByLabel("Required check commands").fill("npm test");
  await owner.getByRole("button", { name: "Save repository" }).click();
  await owner.getByRole("button", { name: "Verify runner" }).click();
  await expect(owner.getByLabel("Runner verification").getByText("passed", { exact: true }).first()).toBeVisible();
  await member.reload();
  await expect(member.getByText(/openfloor\/[0-9a-f]{8}\/candidate\/release-candidate-[0-9a-f]{8}/)).toBeVisible();
  await expect(member.getByRole("button", { name: "Sync repository" })).toHaveCount(0);

  await owner.getByRole("link", { name: "Enter agent floor" }).click();
  await member.getByRole("link", { name: "Enter agent floor" }).click();
  await expect(owner).toHaveURL(/\/app\/session\/[0-9a-f-]+\/floor$/);
  await expect(owner.getByRole("heading", { name: "Agent floor" })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Team" }).locator(".avatar").filter({ hasText: "OE" })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Team" }).locator(".avatar").filter({ hasText: "ME" })).toBeVisible();
  await expect(owner.getByRole("navigation", { name: "Session location" }).getByRole("link", { name: "Release coordination" })).toBeVisible();
  await expect(owner.getByText("Member E.").first()).toBeVisible();
  await expect(owner.getByText("No agents yet")).toBeVisible();
  await expect(owner.getByText("No prompts waiting")).toBeVisible();
  await expect(owner.getByText("No review available")).toHaveCount(0);
  await expect(owner.getByText(/Atlas|Nova|Sentry|Proof|OpenMind/)).toHaveCount(0);

  const ownerComposer = owner.getByLabel("Prompt to add to the queue");
  const memberDraftControls = member.getByRole("group", { name: "Teammate drafts" });
  await expect(memberDraftControls.getByRole("button", { name: "Typing" })).toHaveAttribute("aria-pressed", "true");
  await ownerComposer.fill("A prompt still being written");
  await expect(member.getByLabel("Owner E.'s draft")).toContainText("A prompt still being written");
  await expect(member.getByLabel("Owner E.'s draft")).toContainText("typing");
  await expect(member.getByLabel("Owner E.'s draft")).toHaveCount(0, { timeout: 5_000 });
  await memberDraftControls.getByRole("button", { name: "Everyone" }).click();
  await expect(member.getByLabel("Owner E.'s draft")).toContainText("A prompt still being written");
  await expect(member.getByLabel("Owner E.'s draft")).toContainText("idle");
  await memberDraftControls.getByRole("button", { name: "Hidden" }).click();
  await expect(member.getByLabel("Owner E.'s draft")).toHaveCount(0);
  await memberDraftControls.getByRole("button", { name: "Typing" }).click();
  await ownerComposer.fill("");

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
  await expect(agentFloor.getByRole("tab", { name: "Lumen" })).toBeVisible();
  await expect(member.getByRole("region", { name: "Agent floor" }).getByRole("tab", { name: "Lumen" })).toBeVisible();
  await expect(agentFloor.getByText(/server\/|app\/|tests\//)).toHaveCount(0);

  await owner.getByLabel("Prompt to add to the queue").fill("Document the next backend contract");
  await expect(owner.getByLabel("Prompt to add to the queue")).toHaveValue("Document the next backend contract");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  expect(pageErrors).toEqual([]);
  await expect(owner.locator(".queue-item").getByText("Document the next backend contract", { exact: true })).toBeVisible();
  await expect(owner.getByText("Unassigned", { exact: true }).first()).toBeVisible();
  await expect(member.locator(".queue-item").getByText("Document the next backend contract", { exact: true })).toBeVisible();

  await owner.getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Inspect the real session contract");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  await expect(owner.locator(".queue-item").getByText("Inspect the real session contract", { exact: true })).toBeVisible();
  await expect(member.locator(".queue-item").getByText("Inspect the real session contract", { exact: true })).toBeVisible();

  const teamPanel = owner.getByRole("region", { name: "Team" });
  await teamPanel.getByRole("button", { name: "Chat" }).click();
  await teamPanel.getByLabel("Message the team").fill("The persistent floor is ready");
  await teamPanel.getByRole("button", { name: "Send message" }).click();
  await expect(teamPanel.getByText("The persistent floor is ready")).toBeVisible();
  const memberTeamPanel = member.getByRole("region", { name: "Team" });
  await memberTeamPanel.getByRole("button", { name: "Chat" }).click();
  await expect(memberTeamPanel.getByText("The persistent floor is ready")).toBeVisible();

  await teamPanel.getByRole("button", { name: "Member E." }).click();
  await teamPanel.getByLabel("Message Member E.").fill("Private persisted note");
  await teamPanel.getByRole("button", { name: "Send message" }).click();
  await memberTeamPanel.getByRole("button", { name: "Owner E." }).click();
  await expect(memberTeamPanel.getByText("Private persisted note")).toBeVisible();

  await teamPanel.getByRole("button", { name: "Goals" }).click();
  await teamPanel.getByLabel("Assignment for Owner E.").fill("Own the persistent release");
  await teamPanel.getByLabel("Assignment for Owner E.").blur();
  await memberTeamPanel.getByRole("button", { name: "Goals" }).click();
  await expect(memberTeamPanel.getByLabel("Assignment for Owner E.")).toHaveValue("Own the persistent release");

  await owner.getByRole("button", { name: "Review" }).click();
  await expect(owner.getByRole("heading", { name: "No review available" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Approve candidate" })).toHaveCount(0);
  await expect(owner.getByText(/server\/session\/reducer|AgentCard\.tsx/)).toHaveCount(0);
  await expect(owner.getByText(/typing/i)).toHaveCount(0);
  await expect(owner.getByText(/terminal/i)).toHaveCount(0);

  await owner.getByRole("button", { name: "Workspace" }).click();
  await expect(member.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  await owner.getByRole("button", { name: "Run", exact: true }).click();
  await expect(owner.getByText("integrated", { exact: true }).first()).toBeVisible();
  await expect(agentFloor.getByText("1 changed file", { exact: false })).toBeVisible();
  await expect(agentFloor.getByText("Reviewing the requested change before editing.")).toBeVisible();
  await expect(agentFloor.getByText("$ git status --short")).toBeVisible();
  await expect(agentFloor.getByText("edited src/agent-change.ts")).toBeVisible();
  await agentFloor.getByRole("button", { name: "Open raw log" }).click();
  await expect(agentFloor.getByText("Codex test adapter completed a real deterministic run contract.")).toBeVisible();
  await agentFloor.getByRole("button", { name: "Hide raw log" }).click();
  await owner.reload();
  await expect(owner.getByText("integrated", { exact: true }).first()).toBeVisible();
  await owner.getByRole("button", { name: "Review" }).click();
  await expect(owner.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(owner.getByRole("heading", { name: /openfloor\// })).toBeVisible();
  const commitFact = owner.locator(".review-hero-facts > div", { hasText: "Commit" });
  await expect(commitFact.locator("strong")).toHaveText(/^[0-9a-f]{8}$/);
  await expect(commitFact.locator("strong")).toHaveAttribute("title", /^[0-9a-f]{40}$/);
  await expect(owner.getByText("agent-change.ts", { exact: true })).toBeVisible();
  await expect(owner.getByText("export const implemented = true;", { exact: true })).toBeVisible();
  await expect(owner.getByText("npm test", { exact: true })).toBeVisible();
  await expect(owner.getByRole("link", { name: /Draft PR #1/ })).toHaveAttribute("href", /\/pull\/1$/);

  await owner.getByRole("button", { name: "Workspace" }).click();
  await owner.getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create a second published change");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const secondPublishedItem = owner.locator("li.queue-item", { hasText: "Create a second published change" });
  await secondPublishedItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(secondPublishedItem.getByText("integrated", { exact: true })).toBeVisible();
  await expect(owner.locator("code.queue-run-branch")).toHaveCount(2);
  await owner.getByRole("button", { name: "Review" }).click();
  await expect(owner.getByText("second-change.ts", { exact: true })).toBeVisible();
  await expect(owner.getByRole("link", { name: /Draft PR #1/ })).toHaveCount(1);
  await owner.getByRole("button", { name: "Workspace" }).click();

  await owner.getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create a deliberate integration conflict");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const conflictItem = owner.locator("li.queue-item", { hasText: "Create a deliberate integration conflict" });
  await conflictItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(conflictItem.getByText("conflicted", { exact: true })).toBeVisible();
  const conflictedBranch = await conflictItem.locator("code.queue-run-branch").textContent();
  await expect(member.getByRole("button", { name: "Retry against latest candidate" })).toHaveCount(0);
  await conflictItem.getByRole("button", { name: "Retry against latest candidate" }).click();
  await expect(conflictItem.getByText("integrated", { exact: true })).toBeVisible();
  await expect.poll(async () => conflictItem.locator("code.queue-run-branch").textContent()).not.toBe(conflictedBranch);

  await owner.getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create an intentionally failing change");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const failingItem = owner.locator("li.queue-item", { hasText: "Create an intentionally failing change" });
  await expect(failingItem).toBeVisible();
  await failingItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(owner.getByText("failed", { exact: true }).first()).toBeVisible();
  await expect(failingItem.getByRole("button", { name: "Resume", exact: true })).toBeVisible();

  await owner.getByLabel("Prompt to add to the queue").fill("Hold for cancellation");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const cancellableItem = owner.locator("li.queue-item", { hasText: "Hold for cancellation" });
  await expect(cancellableItem).toBeVisible();
  await cancellableItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(owner.getByText("running", { exact: true }).first()).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(member.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await owner.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(owner.getByText("cancelled", { exact: true }).first()).toBeVisible();
  await expect(cancellableItem.getByRole("button", { name: "Resume", exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Review" }).click();
  await member.getByRole("button", { name: "Review" }).click();
  await expect(member.getByRole("button", { name: "Ready for review" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Squash merge" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Ready for review" }).click();
  await expect(owner.getByRole("link", { name: /PR #1 · open/ })).toBeVisible();
  await expect(owner.getByText("clean", { exact: true })).toBeVisible();
  await expect(owner.getByText("passing", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Squash merge" }).click();
  await owner.getByRole("dialog", { name: "Squash merge this candidate?" })
    .getByRole("button", { name: "Merge, delete branch" }).click();
  await expect(owner.getByText("merged", { exact: true }).first()).toBeVisible();
  await expect(owner.getByLabel("Branch cleanup").getByText("complete", { exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Squash merge" })).toHaveCount(0);

  await owner.getByRole("button", { name: "Workspace" }).click();
  await expect(owner.getByText(/because the candidate branch was merged.*read-only/i)).toBeVisible();

  await member.reload();
  await expect(member.getByRole("region", { name: "Agent floor" }).getByRole("tab", { name: "Lumen" })).toBeVisible();
  await expect(member.locator(".queue-item").getByText("Document the next backend contract", { exact: true })).toBeVisible();

  await owner.getByRole("link", { name: "Release coordination" }).click();
  await member.getByRole("link", { name: "Release coordination" }).click();
  await expect(owner).toHaveURL(/\/app\/session\/[0-9a-f-]+$/);
  await expect(member).toHaveURL(/\/app\/session\/[0-9a-f-]+$/);

  await member.reload();
  await expect(member.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(member.locator(".session-hero").getByText("Coordinate the restored agent floor")).toBeVisible();

  await member.close();
  await expect(owner.locator("li", { hasText: "Member E." }).getByText("Offline", { exact: true })).toBeVisible();

  const reconnectedMember = await memberContext.newPage();
  await reconnectedMember.goto(owner.url());
  await expect(owner.locator("li", { hasText: "Member E." }).getByText("Online", { exact: true })).toBeVisible();
  await reconnectedMember.getByRole("button", { name: "Leave session" }).click();
  await expect(reconnectedMember).toHaveURL(/\/app\/home$/);
  await expect(owner.getByText("Member E.")).toHaveCount(0);

  await owner.reload();
  await expect(owner.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(owner.getByText("Ended session", { exact: true })).toBeVisible();

  const repositorySessionId = new URL(owner.url()).pathname.split("/").at(-1)!;
  const endedMessage = await owner.request.post(`/app/api/sessions/${repositorySessionId}/messages`, { data: { text: "too late" } });
  expect(endedMessage.status()).toBe(409);
  const endedRun = await owner.request.post(`/app/api/sessions/${repositorySessionId}/queue/missing/run`);
  expect(endedRun.status()).toBe(409);
  const endedReview = await owner.request.post(`/app/api/sessions/${repositorySessionId}/review/ready`);
  expect(endedReview.status()).toBe(409);

  await owner.goto("/app/home");
  await owner.getByRole("button", { name: /^Ended/ }).click();
  const retainedCard = owner.locator(".session-card", { hasText: "Release coordination" });
  await retainedCard.getByRole("button", { name: "Delete" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Delete session" }).click();
  await expect(owner.getByText("Release coordination")).toHaveCount(0);

  await owner.getByRole("button", { name: "New session" }).click();
  await owner.getByLabel("Session title").fill("Disposable session");
  await owner.getByRole("button", { name: "Create session" }).click();
  await owner.getByRole("button", { name: "End session", exact: true }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "End session", exact: true }).click();
  await owner.goto("/app/home");
  await owner.getByRole("button", { name: /^Ended/ }).click();
  const disposableCard = owner.locator(".session-card", { hasText: "Disposable session" });
  await disposableCard.getByRole("button", { name: "Delete" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Delete session" }).click();
  await expect(owner.getByText("Disposable session")).toHaveCount(0);

  await ownerContext.close();
  await memberContext.close();
});

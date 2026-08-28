import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { authenticatedContext, skipTourIfOpen } from "./fixtures";

test("owner and member persist, share live presence, reconnect, and leave", async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await authenticatedContext(browser, "owner-e2e", "owner@example.com", "Owner", "Example");
  const memberContext = await authenticatedContext(browser, "member-e2e", "member@example.com", "Member", "Example");
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const pageErrors: string[] = [];
  owner.on("pageerror", (error) => pageErrors.push(error.message));

  const webhookPayload = JSON.stringify({ zen: "phase-one" });
  const webhookSignature = createHmac("sha256", "e2e-test-github-webhook-secret").update(webhookPayload).digest("hex");
  const rejectedWebhook = await owner.request.post("/webhooks/github", {
    data: webhookPayload,
    headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": "sha256=invalid" },
  });
  expect(rejectedWebhook.status()).toBe(401);
  const acceptedWebhook = await owner.request.post("/webhooks/github", {
    data: webhookPayload,
    headers: { "content-type": "application/json", "x-github-event": "ping", "x-hub-signature-256": `sha256=${webhookSignature}` },
  });
  expect(acceptedWebhook.status()).toBe(200);

  await owner.goto("/home");
  await skipTourIfOpen(owner);
  await owner.getByRole("button", { name: "New session" }).click();
  // The create-session dialog is one page: task + goal, repository (the
  // single test repository auto-selects, and the candidate branch name
  // defaults to the task title until edited), and an optional AI
  // connection — create without connecting one.
  await owner.getByLabel("Task").fill("Release coordination");
  await owner.getByLabel(/Goal/).fill("Ship persistent multiplayer sessions");
  await expect(owner.getByLabel("Candidate branch name")).toHaveValue("Release coordination");
  await owner.getByRole("button", { name: "Create session" }).click();
  // A ready provision lands straight on the agent floor; navigate back to
  // the lobby to run this journey's lobby-state assertions before entering
  // the floor again further down, same as every other flow in this test.
  await expect(owner).toHaveURL(/\/session\/[0-9a-f-]+\/floor$/);
  await skipTourIfOpen(owner);
  const createdSessionUrl = owner.url().replace(/\/floor$/, "");
  await owner.goto(createdSessionUrl);
  await expect(owner.getByText("Floor ready")).toBeVisible();
  await expect(owner.getByRole("dialog")).toHaveCount(0);
  await expect(owner.getByText("openfloor-test/repository-integration")).toBeVisible();
  // RepositoryCard itself only shows a status chip for externally_modified
  // (components/product/RepositoryCard.tsx) — the plain-ready state's
  // "Ready" badge lives one level up, on "Prepare the workspace".
  await expect(owner.locator(".setup-status[data-ready='true']")).toHaveText("Ready");
  await expect(owner.getByRole("heading", { name: "Release coordination", exact: true })).toBeVisible();
  await expect(owner.getByText("Ship persistent multiplayer sessions", { exact: true }).first()).toBeVisible();
  await expect(owner.getByText(/openfloor\/[0-9a-f]{8}\/candidate\/release-coordination-[0-9a-f]{8}/)).toBeVisible();
  await owner.reload();
  await expect(owner.getByRole("dialog")).toHaveCount(0);
  await expect(owner.getByText("Owner E.").first()).toBeVisible();
  await expect(owner.getByText("Online", { exact: true })).toBeVisible();

  const inviteUrl = await owner.getByLabel("Active invite link").inputValue();
  expect(inviteUrl).toContain("/join/");

  await member.goto(new URL(inviteUrl).pathname);
  await expect(member.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(member.getByText("Owner E.")).toBeVisible();
  await member.getByRole("button", { name: "Join session" }).click();
  await expect(member).toHaveURL(/\/session\/[0-9a-f-]+$/);

  await expect(owner.getByText("Member E.")).toBeVisible();
  await expect(owner.locator("li", { hasText: "Member E." }).getByText("Online", { exact: true })).toBeVisible();
  await expect(member.locator("li", { hasText: "Owner E." }).getByText("Online", { exact: true })).toBeVisible();

  await member.reload();
  await expect(member.getByText("openfloor-test/repository-integration")).toBeVisible();
  await expect(member.getByRole("button", { name: "Configure" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Disconnect" })).toHaveCount(0);

  await owner.reload();
  // PR #211 removed RepositoryCard's owner Sync/Configure/Disconnect
  // controls — synchronization is server-driven now. A reload re-renders the
  // ready state from D1, which is the durable claim worth keeping here.
  await expect(owner.locator(".setup-status[data-ready='true']")).toHaveText("Ready");
  await expect(owner.getByRole("button", { name: "Sync repository" })).toHaveCount(0);
  await member.reload();
  await expect(member.getByText(/openfloor\/[0-9a-f]{8}\/candidate\/release-coordination-[0-9a-f]{8}/)).toBeVisible();

  await owner.getByRole("link", { name: "Enter agent floor" }).click();
  await member.getByRole("link", { name: "Enter agent floor" }).click();
  await skipTourIfOpen(member);
  await expect(owner).toHaveURL(/\/session\/[0-9a-f-]+\/floor$/);
  await expect(owner.getByRole("heading", { name: "Agent floor" })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Team" }).locator(".avatar").filter({ hasText: "OE" })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Team" }).locator(".avatar").filter({ hasText: "ME" })).toBeVisible();
  await expect(owner.getByRole("navigation", { name: "Session location" }).getByRole("link", { name: "Release coordination" })).toBeVisible();
  await expect(owner.getByText("Member E.").first()).toBeVisible();
  await expect(owner.getByText("No agents yet")).toBeVisible();
  await expect(owner.getByRole("region", { name: "Agent floor" }).getByRole("button", { name: "Auto agents on" })).toHaveAttribute("aria-pressed", "true");
  await expect(member.getByRole("region", { name: "Agent floor" }).getByRole("button", { name: /Auto agents/ })).toHaveCount(0);
  await expect(owner.getByText("No prompts waiting")).toBeVisible();
  await expect(owner.getByText("No review available")).toHaveCount(0);
  await expect(owner.getByText(/Atlas|Nova|Sentry|Proof|OpenMind/)).toHaveCount(0);

  await owner.getByRole("button", { name: "Queue settings" }).click();
  const ownerQueueSettings = owner.getByRole("group", { name: "Queue settings" });
  // Sessions now default to auto-dispatch on; this test exercises the
  // manual "unassigned prompt, manual target, Run" path below, so turn it
  // off first (mirroring the pre-fix default the rest of this journey
  // assumes — every later run in this file is started by an explicit
  // "Run" click, never automatic dispatch).
  await expect(ownerQueueSettings.getByRole("button", { name: /^On/ })).toHaveAttribute("aria-pressed", "true");
  // Choosing closes the menu, like the browser-alerts toggle below — reopen
  // it to confirm the choice stuck.
  await ownerQueueSettings.getByRole("button", { name: /^Off/ }).click();
  await owner.getByRole("button", { name: "Queue settings" }).click();
  await expect(ownerQueueSettings.getByRole("button", { name: /^Off/ })).toHaveAttribute("aria-pressed", "true");
  await expect(ownerQueueSettings.getByRole("button", { name: /^Automatic/ })).toHaveAttribute("aria-pressed", "true");
  await expect(ownerQueueSettings.getByRole("button", { name: /Browser conflict alerts off/ })).toHaveAttribute("aria-pressed", "false");
  await owner.keyboard.press("Escape");
  await member.evaluate(() => {
    const state = {
      permission: "default" as NotificationPermission,
      requestCount: 0,
      notifications: [] as Array<{ title: string; body: string | undefined; click: () => void }>,
    };
    class TestNotification {
      static get permission() { return state.permission; }
      static async requestPermission() {
        state.requestCount += 1;
        state.permission = "granted";
        return state.permission;
      }
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        state.notifications.push({ title, body: options?.body, click: () => this.onclick?.() });
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: TestNotification });
    Object.assign(window, { __conflictAlertTest: state });
  });
  await member.getByRole("button", { name: "Queue settings" }).click();
  const memberQueueSettings = member.getByRole("group", { name: "Queue settings" });
  await expect(memberQueueSettings.getByRole("button", { name: /^Automatic/ })).toHaveCount(0);
  await memberQueueSettings.getByRole("button", { name: /Browser conflict alerts off/ }).click();
  await expect.poll(() => member.evaluate(() => (window as typeof window & { __conflictAlertTest: { requestCount: number } }).__conflictAlertTest.requestCount)).toBe(1);

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
  await expect(owner.getByLabel("Session invite link")).toHaveValue(/\/join\//);
  await owner.getByRole("button", { name: "Done" }).click();

  // The create-agent dialog only offers providers the owner has actually
  // connected a key for (no server-key fallback), so New agent below needs
  // this connected ahead of time. Repository setup no longer offers a
  // credentials step (account-level GitHub setup moved it out), so this
  // goes through Settings → Connections like any other post-onboarding key.
  const sessionUrl = owner.url();
  await owner.goto("/home/settings?section=connections");
  const credentialRow = owner.locator(".provider-credential-row").first();
  const credentialInput = credentialRow.locator("input");
  await credentialRow.getByRole("button", { name: "Not connected" }).click();
  await credentialInput.fill("sk-ant-e2e-accepted");
  await credentialRow.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(credentialRow.getByText("Connected", { exact: true })).toBeVisible();
  await owner.goto(sessionUrl);

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

  await owner.getByRole("button", { name: "Queue settings" }).click();
  await owner.getByRole("group", { name: "Queue settings" }).getByRole("button", { name: /^On openfloor assigns/ }).click();
  for (const prompt of ["Hold persistent for auto provisioning", "Hold generated for auto provisioning"]) {
    await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
    await owner.getByRole("option", { name: "Auto" }).click();
    await owner.getByLabel("Prompt to add to the queue").fill(prompt);
    await owner.getByRole("button", { name: "Add to queue" }).click();
    await expect(owner.locator("li.queue-item", { hasText: prompt })).toBeVisible();
  }
  const persistentHold = owner.locator("li.queue-item", { hasText: "Hold persistent for auto provisioning" });
  const generatedHold = owner.locator("li.queue-item", { hasText: "Hold generated for auto provisioning" });
  await expect(persistentHold.getByText("running", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(generatedHold.getByText("running", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(agentFloor.getByRole("tab", { name: "Auto Worker, auto-generated" })).toBeVisible({ timeout: 60_000 });
  await agentFloor.getByRole("tab", { name: "Auto Worker, auto-generated" }).click();
  await expect(agentFloor.getByText("Auto-generated", { exact: true })).toBeVisible();
  await expect(agentFloor.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(agentFloor.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(agentFloor.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await agentFloor.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(agentFloor.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await agentFloor.getByRole("button", { name: "Resume", exact: true }).click();
  await agentFloor.getByRole("button", { name: "Auto agents on" }).click();
  await expect(agentFloor.getByRole("button", { name: "Auto agents off" })).toHaveAttribute("aria-pressed", "false");
  await persistentHold.getByRole("button", { name: "Cancel", exact: true }).click();
  await generatedHold.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(agentFloor.getByRole("tab", { name: "Auto Worker, auto-generated" })).toHaveCount(0);
  await expect(agentFloor.getByRole("tab", { name: "Lumen" })).toBeVisible();
  await agentFloor.getByRole("button", { name: "Auto agents off" }).click();
  await agentFloor.getByRole("button", { name: "All agents" }).click();
  const gridTopBeforeReply = (await agentFloor.locator(".agent-grid").boundingBox())!.y;
  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("What does the auth module do?");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const answeredItem = owner.locator("li.queue-item", { hasText: "What does the auth module do?" });
  // Answered prompts fold into their collapsed section; open the bar first.
  await owner.locator(".queue-group-bar", { hasText: "Answered" }).click();
  await expect(answeredItem.getByText("answered", { exact: true })).toBeVisible();
  await expect(answeredItem).toHaveAttribute("data-done", "true");
  // The reply renders as a clamped bubble directly on the tile (no hover
  // step since e4e7d85 dropped the speech-bubble chrome); clicking it opens
  // the spotlight with the full text.
  const replyBubble = agentFloor.locator(".agent-reply-bubble");
  await expect(replyBubble).toBeVisible();
  await expect(replyBubble).toContainText(/auth/i);
  expect((await agentFloor.locator(".agent-grid").boundingBox())!.y).toBe(gridTopBeforeReply);
  const lumenCard = agentFloor.locator(".agent-card", { hasText: "Lumen" });
  const cardBounds = (await lumenCard.boundingBox())!;
  const cardControls = (await lumenCard.locator(".agent-controls").boundingBox())!;
  const ownershipFooter = (await lumenCard.locator(".agent-foot").boundingBox())!;
  expect(cardControls.x).toBeGreaterThanOrEqual(cardBounds.x);
  expect(cardControls.y + cardControls.height).toBeLessThanOrEqual(cardBounds.y + cardBounds.height);
  expect(ownershipFooter.y + ownershipFooter.height).toBeLessThanOrEqual(cardBounds.y + cardBounds.height);
  await replyBubble.click();
  await expect(agentFloor.locator(".spotlight-response")).toContainText(/auth/i);
  const spotlightBounds = (await agentFloor.locator(".spotlight").boundingBox())!;
  const spotlightControls = (await agentFloor.locator(".spotlight > .agent-controls").boundingBox())!;
  expect(spotlightControls.x).toBeGreaterThan(spotlightBounds.x);
  expect(spotlightControls.x + spotlightControls.width).toBeLessThan(spotlightBounds.x + spotlightBounds.width);
  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Auto" }).click();
  await owner.getByRole("button", { name: "Queue settings" }).click();
  await owner.getByRole("group", { name: "Queue settings" }).getByRole("button", { name: /^Off Assign and run/ }).click();

  await owner.getByLabel("Prompt to add to the queue").fill("Document the next backend contract");
  await expect(owner.getByLabel("Prompt to add to the queue")).toHaveValue("Document the next backend contract");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  expect(pageErrors).toEqual([]);
  await expect(owner.locator(".queue-item").getByText("Document the next backend contract", { exact: true })).toBeVisible();
  await expect(member.locator(".queue-item").getByText("Document the next backend contract", { exact: true })).toBeVisible();

  // With auto-dispatch off, an unassigned prompt used to have no path to a
  // Run button at all. The owner (who can manage it) sees a target menu in
  // place of the static "Unassigned" chip since Lumen already exists;
  // targeting it manually is what unblocks the Run button. The member
  // can't manage this item (didn't author it, isn't the owner), so they
  // still see the plain "Unassigned" chip, unaffected by the new control.
  await expect(member.getByText("Unassigned", { exact: true }).first()).toBeVisible();
  const unassignedItem = owner.locator("li.queue-item", { hasText: "Document the next backend contract" });
  await expect(unassignedItem.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  // SelectMenu closes on any outside scroll (stale fixed coordinates), so a
  // scroll from a realtime refresh — or the option click's own
  // scroll-into-view — can void the selection between opening the menu and
  // clicking. Retry the whole open-then-pick gesture until it lands.
  await unassignedItem.scrollIntoViewIfNeeded();
  const unassignedTarget = unassignedItem.getByRole("combobox", { name: "Queue target" });
  await expect(async () => {
    await unassignedTarget.click();
    await owner.getByRole("option", { name: "Lumen" }).click({ timeout: 2_000 });
  }).toPass();
  await expect(unassignedItem.getByRole("button", { name: "Lumen", exact: true })).toBeVisible();
  await expect(unassignedItem.getByRole("button", { name: "Run", exact: true })).toBeVisible();

  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Inspect the real session contract");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const firstPublishedItem = owner.locator("li.queue-item", { hasText: "Inspect the real session contract" });
  await expect(firstPublishedItem.getByText("Inspect the real session contract", { exact: true })).toBeVisible();
  await expect(member.locator(".queue-item").getByText("Inspect the real session contract", { exact: true })).toBeVisible();
  const inspectContractItem = owner.locator("li.queue-item", { hasText: "Inspect the real session contract" });

  const teamPanel = owner.getByRole("region", { name: "Team" });
  await teamPanel.getByRole("button", { name: "Chat" }).click();
  await teamPanel.getByLabel("Message the team").fill("The persistent floor is ready");
  await teamPanel.getByRole("button", { name: "Send message" }).click();
  await expect(teamPanel.getByText("The persistent floor is ready")).toBeVisible();
  const memberTeamPanel = member.getByRole("region", { name: "Team" });
  await skipTourIfOpen(member);
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

  await owner.getByRole("button", { name: /Review/ }).first().click();
  await expect(owner.getByRole("heading", { name: "No review available" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Approve candidate" })).toHaveCount(0);
  await expect(owner.getByText(/server\/session\/reducer|AgentCard\.tsx/)).toHaveCount(0);
  await expect(owner.getByText(/typing/i)).toHaveCount(0);
  await expect(owner.getByText(/terminal/i)).toHaveCount(0);

  // Before any run, Review still lets a member browse the whole connected
  // repository at its base branch — not only files a run has changed.
  await expect(owner.locator(".review-tree-file", { hasText: "README.md" })).toBeVisible();
  await owner.locator(".review-tree-file", { hasText: "README.md" }).click();
  await expect(owner.getByText("# repository-integration", { exact: true })).toBeVisible();
  await owner.locator(".review-tree-dir", { hasText: "src" }).click();
  await owner.locator(".review-tree-file", { hasText: "index.ts" }).click();
  await expect(owner.getByText("export const entry = true;", { exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Workspace" }).click();
  await expect(member.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
  // Scoped, not the bare "Run" button: "Document the next backend contract"
  // (targeted earlier to demonstrate the manual-retarget path) is left
  // queued and unrun for the rest of this test, so it also has a visible
  // Run button now.
  await inspectContractItem.getByRole("button", { name: "Run", exact: true }).click();
  // Integrated prompts fold into their collapsed section; open the bar first.
  await owner.locator(".queue-group-bar", { hasText: "Integrated" }).click();
  await expect(owner.getByText("integrated", { exact: true }).first()).toBeVisible();
  await expect(agentFloor.getByText("1 changed file", { exact: false })).toBeVisible();
  await expect(agentFloor.getByText("Reviewing the requested change before editing.")).toBeVisible();
  await expect(agentFloor.getByText("$ git status --short")).toBeVisible();
  await expect(agentFloor.getByText("edited src/agent-change.ts")).toBeVisible();
  await agentFloor.getByRole("button", { name: "Open raw log" }).click();
  await expect(agentFloor.getByText("Codex test adapter completed a real deterministic run contract.")).toBeVisible();
  await agentFloor.getByRole("button", { name: "Hide raw log" }).click();
  await owner.reload();
  // Section expand state is local and resets on reload — reopen Integrated.
  await owner.locator(".queue-group-bar", { hasText: "Integrated" }).click();
  await expect(owner.getByText("integrated", { exact: true }).first()).toBeVisible();

  // An integrated prompt's card is itself a link into Review's Prompts mode
  // for that exact contribution — no need to hunt through the file browser.
  await inspectContractItem.locator(".queue-prompt").click();
  await expect(owner.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Prompts", exact: true })).toHaveAttribute("aria-pressed", "true");
  const promptContributionDetail = owner.getByLabel("Prompt contribution detail");
  await expect(promptContributionDetail.getByText("Inspect the real session contract", { exact: true })).toBeVisible();
  await expect(promptContributionDetail.getByText("src/agent-change.ts", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Workspace" }).click();

  await owner.getByRole("button", { name: /Review/ }).first().click();
  await expect(owner.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(owner.getByRole("heading", { name: /openfloor\// })).toBeVisible();
  const commitFact = owner.locator(".review-hero-facts > div", { hasText: "Commit" });
  await expect(commitFact.locator("strong")).toHaveText(/^[0-9a-f]{8}$/);
  await expect(commitFact.locator("strong")).toHaveAttribute("title", /^[0-9a-f]{40}$/);
  await expect(owner.getByText("agent-change.ts", { exact: true })).toBeVisible();
  await expect(owner.getByText("export const implemented = true;", { exact: true })).toBeVisible();
  await expect(owner.getByRole("link", { name: /Draft PR #1/ })).toHaveAttribute("href", /\/pull\/1$/);

  // The changed file is still reachable through the repository browser, and
  // selecting it there shows its diff, not the raw candidate-head content.
  await owner.getByRole("button", { name: "All files" }).click();
  await owner.locator(".review-tree-dir", { hasText: "src" }).click();
  await owner.locator(".review-tree-file", { hasText: "agent-change.ts" }).click();
  await expect(owner.getByRole("button", { name: "Changed (1)" })).toHaveAttribute("aria-pressed", "true");
  await expect(owner.getByText("export const implemented = true;", { exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Workspace" }).click();
  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create a second published change");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const secondPublishedItem = owner.locator("li.queue-item", { hasText: "Create a second published change" });
  await secondPublishedItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(secondPublishedItem.getByText("integrated", { exact: true })).toBeVisible();
  await expect(firstPublishedItem.locator("code.queue-run-branch")).toHaveCount(1);
  await expect(secondPublishedItem.locator("code.queue-run-branch")).toHaveCount(1);
  await owner.getByRole("button", { name: /Review/ }).first().click();
  await expect(owner.getByText("second-change.ts", { exact: true })).toBeVisible();
  await expect(owner.getByRole("link", { name: /Draft PR #1/ })).toHaveCount(1);
  await owner.getByRole("button", { name: "Workspace" }).click();

  // A non-owner engineer can roll back the integrated change produced from
  // their own prompt. The immutable run stays visible, while the candidate
  // advances to a new inverse commit and Review drops that run's file.
  await member.getByRole("combobox", { name: "Queue target" }).click();
  await member.getByRole("option", { name: "Lumen" }).click();
  await member.getByLabel("Prompt to add to the queue").fill("Create a member rollback change");
  await member.getByRole("button", { name: "Add to queue" }).click();
  const ownerRollbackItem = owner.locator("li.queue-item", { hasText: "Create a member rollback change" });
  const memberRollbackItem = member.locator("li.queue-item", { hasText: "Create a member rollback change" });
  await ownerRollbackItem.getByRole("button", { name: "Run", exact: true }).click();
  await member.locator(".queue-group-bar", { hasText: "Integrated" }).click();
  await expect(memberRollbackItem.getByText("integrated", { exact: true })).toBeVisible();
  await expect(memberRollbackItem.getByRole("button", { name: "Remove changes" })).toBeVisible();
  await memberRollbackItem.getByRole("button", { name: "Remove changes" }).click();
  const rollbackImpact = member.getByRole("dialog", { name: "Remove these prompt changes?" });
  await expect(rollbackImpact.getByText("Create a member rollback change", { exact: true })).toBeVisible();
  await rollbackImpact.getByRole("button", { name: "Remove changes" }).click();
  await expect(memberRollbackItem.getByText("rolled back", { exact: true })).toBeVisible();
  await expect(ownerRollbackItem.getByText("rolled back", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: /Review/ }).first().click();
  await expect(owner.getByText("member-change.ts", { exact: true })).toHaveCount(0);
  await owner.getByRole("button", { name: "Prompts", exact: true }).click();
  await owner.getByRole("button", { name: "History", exact: true }).click();
  const rollbackHistoryItem = owner.locator(".review-prompt-item", { hasText: "Create a member rollback change" });
  await expect(rollbackHistoryItem).toBeVisible();
  await expect(rollbackHistoryItem.getByText(/Rolled back/)).toBeVisible();
  await owner.getByRole("button", { name: "Workspace" }).click();

  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create a deliberate integration conflict");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const conflictItem = owner.locator("li.queue-item", { hasText: "Create a deliberate integration conflict" });
  await conflictItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(conflictItem.getByText("Merge Resolver", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(conflictItem.getByText("integrated", { exact: true })).toBeVisible();
  await expect(member.getByRole("button", { name: "Retry against latest candidate" })).toHaveCount(0);
  await expect(conflictItem.getByRole("button", { name: "Retry against latest candidate" })).toHaveCount(0);
  await owner.getByRole("button", { name: /Review/ }).first().click();
  const automaticConflict = owner.locator(".conflict-case", { hasText: "Create a deliberate integration conflict" });
  await expect(automaticConflict.getByText("resolved", { exact: true })).toBeVisible();
  await expect(owner.getByLabel("Integration warnings").getByText("No integration warnings.")).toBeVisible();

  await owner.getByRole("button", { name: "Workspace" }).click();
  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create a conflict needing a session decision");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const questionConflictItem = owner.locator("li.queue-item", { hasText: "Create a conflict needing a session decision" });
  await questionConflictItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(member.getByText("Merge conflict needs a decision", { exact: true })).toBeVisible();
  await owner.reload();
  await expect(owner.getByText("Merge conflict needs a decision", { exact: true })).toBeVisible();
  await member.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => member.evaluate(() => (window as typeof window & { __conflictAlertTest: { notifications: unknown[] } }).__conflictAlertTest.notifications.length)).toBe(1);
  await member.evaluate(() => {
    (window as typeof window & { __conflictAlertTest: { notifications: Array<{ click: () => void }> } }).__conflictAlertTest.notifications[0].click();
  });
  await expect(member.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  const memberQuestionConflict = member.locator(".conflict-case[data-selected='true']", { hasText: "Create a conflict needing a session decision" });
  await expect(memberQuestionConflict).toBeVisible();
  const floorResponse = await member.request.get(new URL(member.url()).pathname.replace(/\/floor$/, "/floor").replace("/session/", "/api/sessions/"));
  const questionFloor = await floorResponse.json() as { floor: { review: { conflicts: Array<{ id: string; status: string; questions: Array<{ id: string; answer: string | null }> }> } | null } };
  const questionCase = questionFloor.floor.review?.conflicts.find((item) => item.status === "awaiting_input");
  expect(questionCase).toBeTruthy();
  await expect(memberQuestionConflict.getByText(/Waiting for the session owner or an original prompt author/)).toBeVisible();
  await expect(memberQuestionConflict.locator("textarea")).toHaveCount(0);
  await owner.getByRole("button", { name: /Review/ }).first().click();
  const ownerQuestionConflict = owner.locator(".conflict-case[data-selected='true']", { hasText: "Create a conflict needing a session decision" });
  const answerFields = ownerQuestionConflict.locator("textarea");
  await answerFields.nth(0).fill("Preserve the existing public behavior.");
  await answerFields.nth(1).fill("Do not remove the legacy path yet.");
  await ownerQuestionConflict.getByRole("button", { name: "Submit answers" }).click();
  // Resolution clears the case's selected state, so assert on the case
  // itself rather than the [data-selected] scope used to answer it.
  await expect(owner.locator(".conflict-case", { hasText: "Create a conflict needing a session decision" }).getByText("resolved", { exact: true })).toBeVisible();
  const staleAnswer = await owner.request.post(`/api/sessions/${new URL(owner.url()).pathname.split("/")[2]}/conflicts/${questionCase!.id}/answers`, {
    data: { answers: questionCase!.questions.map((question) => ({ questionId: question.id, answer: "Stale answer" })) },
  });
  expect(staleAnswer.status()).toBe(409);
  expect(await member.evaluate(() => (window as typeof window & { __conflictAlertTest: { notifications: unknown[] } }).__conflictAlertTest.notifications.length)).toBe(1);

  await owner.getByRole("button", { name: "Workspace" }).click();
  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create a candidate movement conflict");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const movementItem = owner.locator("li.queue-item", { hasText: "Create a candidate movement conflict" });
  await movementItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(movementItem.getByText("integrated", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: /Review/ }).first().click();
  const movementConflict = owner.locator(".conflict-case", { hasText: "Create a candidate movement conflict" });
  await expect(movementConflict.getByText("Attempt 1 · automatic · conflicted", { exact: true })).toBeVisible();
  await expect(movementConflict.getByText("Attempt 2 · automatic · integrated", { exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Workspace" }).click();
  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create a resolver check failure");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const resolverCheckItem = owner.locator("li.queue-item", { hasText: "Create a resolver check failure" });
  await resolverCheckItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(resolverCheckItem.getByText("integrated", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: /Review/ }).first().click();
  const resolverCheckConflict = owner.locator(".conflict-case", { hasText: "Create a resolver check failure" });
  await expect(resolverCheckConflict.getByText("Attempt 1 · automatic · failed", { exact: true })).toBeVisible();
  await expect(resolverCheckConflict.getByText("Attempt 2 · automatic · integrated", { exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Workspace" }).click();
  await owner.getByRole("button", { name: "Queue settings" }).click();
  await owner.getByRole("group", { name: "Queue settings" }).getByRole("button", { name: /Manual Record conflicts/ }).click();
  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create a manual merge conflict");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const manualConflictItem = owner.locator("li.queue-item", { hasText: "Create a manual merge conflict" });
  await manualConflictItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(manualConflictItem.getByText("conflicted", { exact: true })).toBeVisible();
  await expect(manualConflictItem.getByRole("button", { name: "Retry against latest candidate" })).toHaveCount(0);
  await owner.getByRole("button", { name: /Review/ }).first().click();
  const manualConflict = owner.locator(".conflict-case", { hasText: "Create a manual merge conflict" });
  await expect(manualConflict.getByRole("button", { name: "Start Merge Resolver" })).toBeVisible();
  await member.getByRole("button", { name: /Review/ }).first().click();
  await expect(member.locator(".conflict-case", { hasText: "Create a manual merge conflict" }).getByRole("button", { name: "Start Merge Resolver" })).toHaveCount(0);
  await manualConflict.getByRole("button", { name: "Start Merge Resolver" }).click();
  await expect(manualConflict.getByText("resolved", { exact: true })).toBeVisible();

  await owner.getByRole("button", { name: "Workspace" }).click();
  await owner.getByRole("region", { name: "Open floor" }).getByRole("combobox", { name: "Queue target" }).click();
  await owner.getByRole("option", { name: "Lumen" }).click();
  await owner.getByLabel("Prompt to add to the queue").fill("Create an intentionally failing change");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const failingItem = owner.locator("li.queue-item", { hasText: "Create an intentionally failing change" });
  await expect(failingItem).toBeVisible();
  await failingItem.getByRole("button", { name: "Run", exact: true }).click();
  // Failed prompts fold into their collapsed section; open the bar first.
  await owner.locator(".queue-group-bar", { hasText: "Failed" }).click();
  await expect(owner.getByText("failed", { exact: true }).first()).toBeVisible();
  await expect(failingItem.getByRole("button", { name: "Resume", exact: true })).toBeVisible();

  // A failed card is clickable — it expands in place to the agent's saved
  // failure message instead of just saying "failed". Check commands are
  // removed this release, so the detail carries the run summary and no
  // per-check output block.
  await expect(failingItem.getByText("The agent run failed.", { exact: true })).toHaveCount(0);
  await failingItem.locator(".queue-prompt").click();
  await expect(failingItem.getByText("The agent run failed.", { exact: true })).toBeVisible();
  await expect(failingItem.locator(".queue-detail-checks")).toHaveCount(0);
  await failingItem.locator(".queue-chip[data-kind=\"status\"]").click();
  await expect(failingItem.getByText("The agent run failed.", { exact: true })).toHaveCount(0);

  await owner.getByLabel("Prompt to add to the queue").fill("Hold for cancellation");
  await owner.getByRole("button", { name: "Add to queue" }).click();
  const cancellableItem = owner.locator("li.queue-item", { hasText: "Hold for cancellation" });
  await expect(cancellableItem).toBeVisible();
  await cancellableItem.getByRole("button", { name: "Run", exact: true }).click();
  await expect(owner.getByText("running", { exact: true }).first()).toBeVisible();

  // A running card is clickable too — it jumps straight to that agent in
  // the floor's focused view, not an inline expansion.
  await cancellableItem.locator(".queue-prompt").click();
  await expect(agentFloor.locator(".spotlight")).toBeVisible();
  await expect(agentFloor.locator(".spotlight").getByText("Lumen", { exact: true }).first()).toBeVisible();

  await owner.reload();
  await expect(owner.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(member.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await owner.getByRole("button", { name: "Cancel", exact: true }).click();
  // Cancelled prompts fold into their collapsed section; open the bar first.
  await owner.locator(".queue-group-bar", { hasText: "Cancelled" }).click();
  await expect(owner.getByText("cancelled", { exact: true }).first()).toBeVisible();
  await expect(cancellableItem.getByRole("button", { name: "Resume", exact: true })).toBeVisible();

  await owner.getByRole("button", { name: /Review/ }).first().click();
  await member.getByRole("button", { name: /Review/ }).first().click();
  await expect(member.getByRole("button", { name: "Ready for review" })).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Squash merge" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Ready for review" }).click();
  // PR #217 split the link ("PR #1 on GitHub") from the state line ("open").
  await expect(owner.getByRole("link", { name: /PR #1 on GitHub/ })).toBeVisible();
  await expect(owner.getByText("open", { exact: true })).toBeVisible();
  await expect(owner.getByText("clean", { exact: true })).toBeVisible();
  await expect(owner.getByText("passing", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Squash merge" }).click();
  await owner.getByRole("dialog", { name: "Squash merge this candidate?" })
    .getByRole("button", { name: "Merge, delete branch" }).click();

  // Merging the candidate branch ends the session for everyone, and the
  // session.ended broadcast (sent server-side before the merge route even
  // returns) races ahead of the merge response — the owner is forced back
  // to this lobby rather than seeing an in-place "merged" confirmation on
  // the Review screen first.
  await expect(owner).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(owner.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(owner.getByText(/because the candidate branch was merged/i)).toBeVisible();

  await member.reload();
  await expect(member).toHaveURL(/\/session\/[0-9a-f-]+$/);
  await expect(member.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(member.locator(".session-hero").getByText("Coordinate the restored agent floor")).toBeVisible();
  await expect(member.getByText(/because the candidate branch was merged/i)).toBeVisible();

  await member.close();
  await expect(owner.locator("li", { hasText: "Member E." }).getByText("Offline", { exact: true })).toBeVisible();

  const reconnectedMember = await memberContext.newPage();
  await reconnectedMember.goto(owner.url());
  await expect(owner.locator("li", { hasText: "Member E." }).getByText("Online", { exact: true })).toBeVisible();
  await reconnectedMember.getByRole("button", { name: "Leave session" }).click();
  await expect(reconnectedMember).toHaveURL(/\/home$/);
  await expect(owner.getByText("Member E.")).toHaveCount(0);

  await owner.reload();
  await expect(owner.getByRole("heading", { name: "Release coordination" })).toBeVisible();
  await expect(owner.getByText("Ended session", { exact: true })).toBeVisible();

  const repositorySessionId = new URL(owner.url()).pathname.split("/").at(-1)!;
  const endedMessage = await owner.request.post(`/api/sessions/${repositorySessionId}/messages`, { data: { text: "too late" } });
  expect(endedMessage.status()).toBe(409);
  const endedRun = await owner.request.post(`/api/sessions/${repositorySessionId}/queue/missing/run`);
  expect(endedRun.status()).toBe(409);
  const endedReview = await owner.request.post(`/api/sessions/${repositorySessionId}/review/ready`);
  expect(endedReview.status()).toBe(409);

  await owner.goto("/home");
  await owner.getByRole("button", { name: /^Ended/ }).click();
  const retainedCard = owner.locator(".session-card", { hasText: "Release coordination" });
  await retainedCard.getByRole("button", { name: "Session actions" }).click();
  // The tab panel's entrance stagger and the actions-open tilt reset both
  // animate transform, and the stagger's animation-delay means the card can
  // sit still at its offset position — sampling for stillness isn't enough.
  // Wait for every running animation and transition to finish instead.
  await retainedCard.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => null))),
  );
  const retainedBounds = await retainedCard.boundingBox();
  const retainedDelete = await retainedCard.getByRole("button", { name: "Delete" }).boundingBox();
  await owner.mouse.move(retainedDelete!.x + retainedDelete!.width / 2, retainedDelete!.y + 1);
  // Position only: the claim is that the magnet tilt stays zeroed while the
  // actions menu is open, not that the inline reveal can't wrap the meta
  // strip and grow the card.
  const afterHover = await retainedCard.boundingBox();
  expect({ x: afterHover!.x, y: afterHover!.y }).toEqual({ x: retainedBounds!.x, y: retainedBounds!.y });
  await retainedCard.getByRole("button", { name: "Delete" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Delete session" }).click();
  await expect(owner.getByText("Release coordination")).toHaveCount(0);

  // The New session tile only renders on the Active tab.
  await owner.getByRole("button", { name: /^Active/ }).click();
  await skipTourIfOpen(owner);
  await owner.getByRole("button", { name: "New session" }).click();
  // One-page create dialog: only the task is required.
  await owner.getByLabel("Task").fill("Disposable session");
  await owner.getByRole("button", { name: "Create session" }).click();
  // Creation routes straight to the floor; End session lives in the lobby.
  await expect(owner).toHaveURL(/\/session\/[0-9a-f-]+\/floor$/);
  await owner.goto(owner.url().replace(/\/floor$/, ""));
  await owner.getByRole("button", { name: "End session", exact: true }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "End session", exact: true }).click();
  await owner.goto("/home");
  await owner.getByRole("button", { name: /^Ended/ }).click();
  const disposableCard = owner.locator(".session-card", { hasText: "Disposable session" });
  await disposableCard.getByRole("button", { name: "Session actions" }).click();
  await disposableCard.getByRole("button", { name: "Delete" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Delete session" }).click();
  // ENG-83/#216: a live candidate no longer refuses deletion outright — the
  // dialog asks what happens to the branch. Orphaning it deletes the
  // session and reports the branch was kept.
  await expect(owner.getByRole("dialog").getByText(/hasn[’']t merged yet\. Decide what happens to it/)).toBeVisible();
  await owner.getByRole("dialog").getByRole("button", { name: "Leave branch, delete session" }).click();
  await expect(owner.getByRole("dialog").getByRole("status")).toContainText("Session deleted");
  await owner.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(owner.getByText("Disposable session")).toHaveCount(0);

  await ownerContext.close();
  await memberContext.close();
});

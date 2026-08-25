import { expect, test } from "@playwright/test";
import { authenticatedContext } from "./fixtures";

// A distinct spec rather than extending persistent-sessions.spec.ts's
// two-context flow: this exercises a whole-session lifecycle (four
// participants, a capacity boundary) rather than one collaborative floor,
// and new users default to the free plan (3 seats: owner + 2), so no plan
// grant is needed to hit the cap.
test("free-tier seat cap refuses a fourth member with the session already full", async ({ browser }) => {
  const ownerContext = await authenticatedContext(browser, "plan-cap-owner", "plan-cap-owner@example.com", "Owner", "Example");
  const memberOneContext = await authenticatedContext(browser, "plan-cap-member-one", "plan-cap-member-one@example.com", "MemberOne", "Example");
  const memberTwoContext = await authenticatedContext(browser, "plan-cap-member-two", "plan-cap-member-two@example.com", "MemberTwo", "Example");
  const memberThreeContext = await authenticatedContext(browser, "plan-cap-member-three", "plan-cap-member-three@example.com", "MemberThree", "Example");
  const owner = await ownerContext.newPage();
  const memberOne = await memberOneContext.newPage();
  const memberTwo = await memberTwoContext.newPage();
  const memberThree = await memberThreeContext.newPage();

  await owner.goto("/home");
  await expect(owner.getByText("Free plan · 0s of 2h session time used this month (UTC)")).toBeVisible();
  await owner.getByRole("button", { name: "New session" }).click();
  await owner.getByLabel("Session title").fill("Free tier session");
  await owner.getByRole("button", { name: "Create session" }).click();
  await expect(owner).toHaveURL(/\/session\/[0-9a-f-]+$/);
  const inviteUrl = await owner.getByLabel("Active invite link").inputValue();
  const invitePath = new URL(inviteUrl).pathname;

  // Free is 3 seats total (owner + 2): the first two joins fill the session
  // exactly, matching PLAN_LIMITS.free in lib/plans.ts.
  await memberOne.goto(invitePath);
  await memberOne.getByRole("button", { name: "Join session" }).click();
  await expect(memberOne).toHaveURL(/\/session\/[0-9a-f-]+$/);

  await memberTwo.goto(invitePath);
  await memberTwo.getByRole("button", { name: "Join session" }).click();
  await expect(memberTwo).toHaveURL(/\/session\/[0-9a-f-]+$/);

  await expect(owner.getByText("MemberOne E.")).toBeVisible();
  await expect(owner.getByText("MemberTwo E.")).toBeVisible();

  // The third member sees the session is already full before ever clicking
  // Join — the InvitePreview's seat count, not just the 403 enforcement.
  await memberThree.goto(invitePath);
  await expect(memberThree.getByText("This session is full (3 of 3 seats).")).toBeVisible();
  const joinButton = memberThree.getByRole("button", { name: "Session full" });
  await expect(joinButton).toBeDisabled();

  // The advisory button being disabled is not the enforcement — the 403 is.
  const refused = await memberThree.request.post(`/api/invites/${invitePath.split("/").pop()}/accept`);
  expect(refused.status()).toBe(403);
  const body = await refused.json() as { error?: string };
  expect(body.error).toContain("seat limit");

  await ownerContext.close();
  await memberOneContext.close();
  await memberTwoContext.close();
  await memberThreeContext.close();
});

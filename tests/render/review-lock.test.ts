import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { completeTestOnboarding, testRepositorySelection } from "./github-fixture";

function identity(id: string, name: string) {
  return {
    accept: "application/json",
    host: "localhost",
    "x-openfloor-dev-user-id": id,
    "x-openfloor-dev-user-email": `${id}@example.com`,
    "x-openfloor-dev-user-name": name,
  };
}

async function createReviewSession() {
  const ownerHeaders = identity("review-lock-owner", "Review Owner");
  await completeTestOnboarding(ownerHeaders, "Review", "Owner");
  const response = await SELF.fetch("http://localhost/api/sessions", {
    method: "POST",
    headers: { ...ownerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ title: "Locked review", ...await testRepositorySelection(ownerHeaders) }),
  });
  expect(response.status).toBe(201);
  const { session } = await response.json() as { session: { id: string } };
  return { ownerHeaders, sessionId: session.id };
}

describe("review merge lock", () => {
  it("is owner-only, validates input, persists, and blocks in-app merge", async () => {
    const { ownerHeaders, sessionId } = await createReviewSession();
    const route = `http://localhost/api/sessions/${sessionId}/review/merge-lock`;

    const invalid = await SELF.fetch(route, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ locked: "yes" }),
    });
    expect(invalid.status).toBe(400);

    const memberHeaders = identity("review-lock-member", "Review Member");
    await completeTestOnboarding(memberHeaders, "Review", "Member");
    const invite = await (await SELF.fetch(`http://localhost/api/sessions/${sessionId}/invite`, { headers: ownerHeaders })).json() as { inviteUrl: string };
    const token = invite.inviteUrl.split("/join/").pop()!;
    expect((await SELF.fetch(`http://localhost/api/invites/${token}/accept`, { method: "POST", headers: memberHeaders })).status).toBe(200);
    const denied = await SELF.fetch(route, {
      method: "PATCH",
      headers: { ...memberHeaders, "content-type": "application/json" },
      body: JSON.stringify({ locked: true }),
    });
    expect(denied.status).toBe(404);

    const locked = await SELF.fetch(route, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ locked: true }),
    });
    expect(locked.status).toBe(200);
    await expect(locked.json()).resolves.toMatchObject({
      floor: { activeCandidate: { mergeLockedAt: expect.any(Number) } },
    });

    const merge = await SELF.fetch(`http://localhost/api/sessions/${sessionId}/review/merge`, {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ deleteCandidateBranch: false }),
    });
    expect(merge.status).toBe(409);
    await expect(merge.json()).resolves.toEqual({ error: "Squash merge is locked for this candidate" });

    const unlocked = await SELF.fetch(route, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ locked: false }),
    });
    expect(unlocked.status).toBe(200);
    await expect(unlocked.json()).resolves.toMatchObject({
      floor: { activeCandidate: { mergeLockedAt: null } },
    });
  });
});

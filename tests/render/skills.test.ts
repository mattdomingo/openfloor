import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const VALID_SKILL = `---
name: release-checklist
description: Use when preparing a release.
---

Check the changelog first.
`;

async function onboardedUser(providerUserId: string, firstName: string, lastName: string) {
  const headers = {
    accept: "text/html",
    host: "localhost",
    "x-openfloor-dev-user-id": providerUserId,
    "x-openfloor-dev-user-email": `${providerUserId}@example.com`,
    "x-openfloor-dev-user-name": `${firstName} ${lastName}`,
  };
  const form = new FormData();
  form.set("firstName", firstName);
  form.set("lastName", lastName);
  const onboarded = await SELF.fetch("http://localhost/app/api/account/onboarding", { method: "POST", headers, body: form });
  expect(onboarded.status).toBe(204);
  const row = await env.DB.prepare("SELECT id FROM users WHERE chatgpt_user_id = ?").bind(providerUserId).first<{ id: string }>();
  if (!row) throw new Error("Onboarded user was not persisted");
  return { userId: row.id, headers };
}

function jsonHeaders(headers: Record<string, string>) {
  return { ...headers, "content-type": "application/json" };
}

describe("session skills routes", () => {
  it("owner imports and deletes; members read; outsiders and anonymous get nothing", async () => {
    const owner = await onboardedUser("skills-route-owner", "Skill", "Owner");
    const member = await onboardedUser("skills-route-member", "Skill", "Member");
    const outsider = await onboardedUser("skills-route-outsider", "Skill", "Outsider");

    const created = await SELF.fetch("http://localhost/app/api/sessions", {
      method: "POST",
      headers: jsonHeaders(owner.headers),
      body: JSON.stringify({ title: "Skills room" }),
    });
    expect(created.status).toBe(201);
    const { session, inviteUrl } = (await created.json()) as { session: { id: string }; inviteUrl: string };
    const token = inviteUrl.split("/join/")[1];
    const joined = await SELF.fetch(`http://localhost/app/api/invites/${token}/accept`, { method: "POST", headers: member.headers });
    expect(joined.status).toBe(200);

    const invalid = await SELF.fetch(`http://localhost/app/api/sessions/${session.id}/skills`, {
      method: "POST",
      headers: jsonHeaders(owner.headers),
      body: JSON.stringify({ content: "not a skill" }),
    });
    expect(invalid.status).toBe(400);

    const imported = await SELF.fetch(`http://localhost/app/api/sessions/${session.id}/skills`, {
      method: "POST",
      headers: jsonHeaders(owner.headers),
      body: JSON.stringify({ content: VALID_SKILL }),
    });
    expect(imported.status).toBe(201);
    const { skills } = (await imported.json()) as { skills: Array<{ id: string; name: string }> };
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("release-checklist");

    const memberList = await SELF.fetch(`http://localhost/app/api/sessions/${session.id}/skills`, { headers: member.headers });
    expect(memberList.status).toBe(200);
    expect(((await memberList.json()) as { skills: unknown[] }).skills).toHaveLength(1);

    const memberImport = await SELF.fetch(`http://localhost/app/api/sessions/${session.id}/skills`, {
      method: "POST",
      headers: jsonHeaders(member.headers),
      body: JSON.stringify({ content: VALID_SKILL }),
    });
    expect(memberImport.status).toBe(404);

    const outsiderList = await SELF.fetch(`http://localhost/app/api/sessions/${session.id}/skills`, { headers: outsider.headers });
    expect(outsiderList.status).toBe(404);
    const anonymous = await SELF.fetch(`http://localhost/app/api/sessions/${session.id}/skills`);
    expect(anonymous.status).toBe(401);

    const memberDelete = await SELF.fetch(`http://localhost/app/api/sessions/${session.id}/skills/${skills[0].id}`, {
      method: "DELETE",
      headers: member.headers,
    });
    expect(memberDelete.status).toBe(404);
    const removed = await SELF.fetch(`http://localhost/app/api/sessions/${session.id}/skills/${skills[0].id}`, {
      method: "DELETE",
      headers: owner.headers,
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { skills: unknown[] }).skills).toHaveLength(0);
  });
});

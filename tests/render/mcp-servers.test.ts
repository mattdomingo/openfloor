import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { completeTestOnboarding, testRepositorySelection } from "./github-fixture";

async function onboardedUser(providerUserId: string, firstName: string, lastName: string) {
  const headers = {
    accept: "text/html",
    host: "localhost",
    "x-openfloor-dev-user-id": providerUserId,
    "x-openfloor-dev-user-email": `${providerUserId}@example.com`,
    "x-openfloor-dev-user-name": `${firstName} ${lastName}`,
  };
  await completeTestOnboarding(headers, firstName, lastName);
  const row = await env.DB.prepare("SELECT id FROM users WHERE chatgpt_user_id = ?").bind(providerUserId).first<{ id: string }>();
  if (!row) throw new Error("Onboarded user was not persisted");
  return { userId: row.id, headers };
}

function jsonHeaders(headers: Record<string, string>) {
  return { ...headers, "content-type": "application/json" };
}

describe("session MCP server routes", () => {
  it("owner configures write-only servers; members read names; outsiders concealed", async () => {
    const owner = await onboardedUser("mcp-route-owner", "Mcp", "Owner");
    const member = await onboardedUser("mcp-route-member", "Mcp", "Member");
    const outsider = await onboardedUser("mcp-route-outsider", "Mcp", "Outsider");

    const created = await SELF.fetch("http://localhost/api/sessions", {
      method: "POST",
      headers: jsonHeaders(owner.headers),
      body: JSON.stringify({ title: "MCP room", ...await testRepositorySelection(owner.headers) }),
    });
    expect(created.status).toBe(201);
    const { session, inviteUrl } = (await created.json()) as { session: { id: string }; inviteUrl: string };
    const token = inviteUrl.split("/join/")[1];
    expect((await SELF.fetch(`http://localhost/api/invites/${token}/accept`, { method: "POST", headers: member.headers })).status).toBe(200);

    const reserved = await SELF.fetch(`http://localhost/api/sessions/${session.id}/mcp-servers`, {
      method: "POST",
      headers: jsonHeaders(owner.headers),
      body: JSON.stringify({ name: "openfloor", transport: "http", url: "https://mcp.example.com" }),
    });
    expect(reserved.status).toBe(400);

    const added = await SELF.fetch(`http://localhost/api/sessions/${session.id}/mcp-servers`, {
      method: "POST",
      headers: jsonHeaders(owner.headers),
      body: JSON.stringify({
        name: "issue-tracker",
        transport: "http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer render-header-secret" },
      }),
    });
    expect(added.status).toBe(201);
    const addedText = await added.text();
    // Write-only: the header value never comes back.
    expect(addedText).not.toContain("render-header-secret");
    const { servers } = JSON.parse(addedText) as { servers: Array<{ id: string; headerNames: string[]; enabled: boolean }> };
    expect(servers[0].headerNames).toEqual(["Authorization"]);

    const duplicate = await SELF.fetch(`http://localhost/api/sessions/${session.id}/mcp-servers`, {
      method: "POST",
      headers: jsonHeaders(owner.headers),
      body: JSON.stringify({ name: "issue-tracker", transport: "http", url: "https://mcp.example.com/v1" }),
    });
    expect(duplicate.status).toBe(409);

    const memberList = await SELF.fetch(`http://localhost/api/sessions/${session.id}/mcp-servers`, { headers: member.headers });
    expect(memberList.status).toBe(200);
    expect(await memberList.text()).not.toContain("render-header-secret");
    const memberMutate = await SELF.fetch(`http://localhost/api/sessions/${session.id}/mcp-servers`, {
      method: "POST",
      headers: jsonHeaders(member.headers),
      body: JSON.stringify({ name: "member-server", transport: "http", url: "https://member.example.com" }),
    });
    expect(memberMutate.status).toBe(404);
    expect((await SELF.fetch(`http://localhost/api/sessions/${session.id}/mcp-servers`, { headers: outsider.headers })).status).toBe(404);

    const disabled = await SELF.fetch(`http://localhost/api/sessions/${session.id}/mcp-servers/${servers[0].id}`, {
      method: "PATCH",
      headers: jsonHeaders(owner.headers),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { servers: Array<{ enabled: boolean }> }).servers[0].enabled).toBe(false);

    const removed = await SELF.fetch(`http://localhost/api/sessions/${session.id}/mcp-servers/${servers[0].id}`, {
      method: "DELETE",
      headers: owner.headers,
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { servers: unknown[] }).servers).toHaveLength(0);
  });
});

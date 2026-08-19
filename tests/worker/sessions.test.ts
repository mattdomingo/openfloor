import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  createSession,
  getActiveInviteId,
  getInvitePreview,
  getSessionMembers,
  leaveSession,
  listSessionsForUser,
  revokeInvite,
  rotateInvite,
  upsertUser,
} from "@/db/sessions";

function identity(id: string, name: string) {
  return { providerUserId: `chatgpt-${id}`, email: `${id}@example.com`, displayName: name, fullName: name };
}

describe("D1 session persistence", () => {
  it("upserts users by stable ChatGPT identity", async () => {
    const first = await upsertUser(identity("owner", "Owner One"), env.DB);
    const updated = await upsertUser({ ...identity("owner", "Owner Two"), email: "new@example.com" }, env.DB);

    expect(updated.id).toBe(first.id);
    expect(updated.chatgptUserId).toBe("chatgpt-owner");
    expect(updated.displayName).toBe("Owner Two");
    expect(updated.email).toBe("new@example.com");
  });

  it("creates and lists only the current user's sessions", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const outsider = await upsertUser(identity("outsider", "Outsider"), env.DB);
    const created = await createSession(owner.id, { title: "Persistent room", objective: "Ship sessions" }, env.DB);

    expect(await listSessionsForUser(outsider.id, env.DB)).toEqual([]);
    expect(await listSessionsForUser(owner.id, env.DB)).toEqual([
      expect.objectContaining({ id: created.session.id, role: "owner", memberCount: 1 }),
    ]);
  });

  it("accepts invites idempotently and enforces one membership", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const member = await upsertUser(identity("member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);

    await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);
    await expect(acceptInvite(created.inviteId, member.id, env.DB)).resolves.toBe(created.session.id);
    const members = await getSessionMembers(created.session.id, owner.id, env.DB);
    expect(members).toHaveLength(2);
    expect(members?.map((item) => item.role)).toEqual(["owner", "member"]);
  });

  it("rotates and revokes reusable invites", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    const nextInvite = await rotateInvite(created.session.id, owner.id, env.DB);

    expect(nextInvite).not.toBe(created.inviteId);
    expect(await getInvitePreview(created.inviteId, env.DB)).toBeNull();
    expect(await getActiveInviteId(created.session.id, owner.id, env.DB)).toBe(nextInvite);
    expect(await revokeInvite(created.session.id, owner.id, env.DB)).toBe(true);
    expect(await getActiveInviteId(created.session.id, owner.id, env.DB)).toBeNull();
  });

  it("allows members to leave but prevents owner departure", async () => {
    const owner = await upsertUser(identity("owner", "Owner"), env.DB);
    const member = await upsertUser(identity("member", "Member"), env.DB);
    const created = await createSession(owner.id, { title: "Room", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);

    await expect(leaveSession(created.session.id, owner.id, env.DB)).resolves.toBe("owner");
    await expect(leaveSession(created.session.id, member.id, env.DB)).resolves.toBe("left");
    await expect(leaveSession(created.session.id, member.id, env.DB)).resolves.toBe("missing");
  });
});

import { describe, expect, it } from "vitest";
import { signInviteId, verifyInviteToken } from "@/lib/invites";

describe("invite tokens", () => {
  const inviteId = "1477cdb8-b8b1-48ca-bca4-8248f21794f3";

  it("round trips an id with an HMAC signature", async () => {
    const token = await signInviteId(inviteId, "secret-one");
    expect(token).toMatch(new RegExp(`^${inviteId}\\.[A-Za-z0-9_-]+$`));
    await expect(verifyInviteToken(token, "secret-one")).resolves.toBe(inviteId);
  });

  it("rejects tampering and the wrong secret", async () => {
    const token = await signInviteId(inviteId, "secret-one");
    await expect(verifyInviteToken(`${token}x`, "secret-one")).resolves.toBeNull();
    await expect(verifyInviteToken(token, "secret-two")).resolves.toBeNull();
    await expect(verifyInviteToken("not-a-token", "secret-one")).resolves.toBeNull();
  });
});

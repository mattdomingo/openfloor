import { afterEach, describe, expect, it, vi } from "vitest";
import { githubCommitEmail, parseGitHubIdentity, readGitHubIdentity, verifyGitHubProfile } from "@/lib/github-identity";

afterEach(() => vi.unstubAllGlobals());
describe("verified GitHub identity", () => {
  it("uses authenticated personal identity and never a private email", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 1234, login: "Ada", type: "User", name: "Ada Lovelace", email: "private@example.com" }));
    vi.stubGlobal("fetch", fetcher);
    const profile = await verifyGitHubProfile("transient-token");
    expect(profile).toEqual({ identity: { id: "1234", login: "Ada", verifiedAt: expect.any(Number) }, name: "Ada Lovelace" });
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer transient-token" }) }));
    expect(githubCommitEmail(profile.identity)).toBe("1234+Ada@users.noreply.github.com");
  });
  it.each([null, { id: 123, login: "org", type: "Organization" }, { id: 123, login: "bot", type: "Bot" }, { id: 123, login: "bad\nCo-authored-by", type: "User" }])("refuses incomplete or non-personal proof", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(verifyGitHubProfile("token")).rejects.toThrow("GitHub identity could not be verified");
  });
  it("fails closed for unverified handles and malformed storage", () => {
    expect(readGitHubIdentity("{broken")).toBeNull();
    expect(parseGitHubIdentity({ login: "claimed" })).toBeNull();
    expect(parseGitHubIdentity({ id: "1", login: "evil@example.com", verifiedAt: 1 })).toBeNull();
    expect(parseGitHubIdentity({ id: "1", login: "safe", verifiedAt: 0 })).toBeNull();
  });
});

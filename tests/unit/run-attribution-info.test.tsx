import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunAttributionInfo } from "@/components/session/RunAttributionInfo";
import { githubCommitUrl } from "@/lib/run-attribution";

const author = { userId: "engineer", githubId: "123", login: "Ada" };
describe("visible engineer attribution", () => {
  it("shows original engineer and links real GitHub identity and commit", () => {
    const html = renderToStaticMarkup(createElement(RunAttributionInfo, { attribution: { kind: "human", authors: [author] }, promptedBy: [{ userId: "engineer", name: "Ada L.", deleted: false }], commitUrl: githubCommitUrl("org/repo", "a".repeat(40)) }));
    expect(html).toContain("Prompted by");
    expect(html).toContain("Ada L.");
    expect(html).toContain('href="https://github.com/Ada"');
    expect(html).toContain(`href="https://github.com/org/repo/commit/${"a".repeat(40)}"`);
  });
  it("does not imply GitHub credit for legacy history or deleted engineers", () => {
    const legacy = renderToStaticMarkup(createElement(RunAttributionInfo, { attribution: null, promptedBy: [{ userId: "engineer", name: "Ada L.", deleted: false }] }));
    expect(legacy).toContain("Legacy run; GitHub author credit was not recorded.");
    expect(legacy).not.toContain("href=");
    const deleted = renderToStaticMarkup(createElement(RunAttributionInfo, { attribution: { kind: "human", authors: [author] }, promptedBy: [{ userId: "engineer", name: "Deleted user", deleted: true }] }));
    expect(deleted).toContain("Deleted user");
    expect(deleted).not.toContain("github.com/Ada");
  });
  it("labels system feedback without crediting its bookkeeping owner", () => {
    const html = renderToStaticMarkup(createElement(RunAttributionInfo, { attribution: { kind: "system", authors: [] }, promptedBy: [{ userId: "owner", name: "Owner", deleted: false }] }));
    expect(html).toContain("Automated feedback");
    expect(html).not.toContain("Owner");
  });
  it("creates no links for missing commits or invalid repository metadata", () => {
    expect(githubCommitUrl("org/repo", null)).toBeNull();
    expect(githubCommitUrl("https://evil.test", "a".repeat(40))).toBeNull();
    expect(githubCommitUrl("org/repo", "main")).toBeNull();
  });
});

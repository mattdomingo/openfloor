import { describe, expect, it } from "vitest";
import { mapPullRequestFeedback } from "@/lib/github";
import {
  changesRequestedSignature,
  ciFailureSignature,
  FEEDBACK_MESSAGE_MAX_CHARS,
  formatCIFailureMessage,
  formatReviewChangesRequestedMessage,
  formatReviewCommentsMessage,
  markdownCodeFence,
  parseFeedbackNudgeState,
  planFeedbackNudges,
  reviewCommentsSignature,
  stripControlChars,
  type PullRequestFeedbackObservation,
} from "@/lib/pr-feedback";

const pr = { number: 7, url: "https://github.com/acme/repo/pull/7", state: "open" as const, merged: false, headSha: "a".repeat(40) };

function observation(overrides: Partial<PullRequestFeedbackObservation> = {}): PullRequestFeedbackObservation {
  return { ...pr, reviewDecision: null, failedChecks: [], unresolvedThreads: [], changesRequested: [], ...overrides };
}

const build = { name: "build", status: "failure", url: "https://ci.example/1" };
const thread = (threadId: string, id: string, body = "Rename this") => ({
  threadId,
  comments: [{ id, author: "reviewer", body, path: "src/a.ts", line: 3, url: `https://github.com/acme/repo/pull/7#discussion_r${id}` }],
});

describe("pr-feedback formatting", () => {
  it("strips control characters but keeps newlines and tabs", () => {
    expect(stripControlChars("a\u001b[31mb\u0007c\n\td")).toBe("a[31mbc\n\td");
  });

  it("grows a code fence past embedded fences", () => {
    expect(markdownCodeFence("plain")).toBe("```");
    expect(markdownCodeFence("x ```` y")).toBe("`````");
  });

  it("renders CI, review-comment, and changes-requested messages with the facts the agent needs", () => {
    const ci = formatCIFailureMessage(pr, [build, { name: "\u001b[1mlint", status: "cancelled", url: null }]);
    expect(ci).toContain("CI is failing on PR #7 (https://github.com/acme/repo/pull/7) at aaaaaaaaaaaa.");
    expect(ci).toContain("Failed: build (failure)\nFailure URL: https://ci.example/1");
    expect(ci).toContain("Failed: [1mlint (cancelled)");
    expect(ci).toContain("never push");

    const review = formatReviewCommentsMessage(pr, [thread("T1", "1"), { threadId: "T2", comments: [{ id: "2", author: "", body: "General note", path: null, line: null, url: "https://x/2" }] }]);
    expect(review).toContain("2 unresolved review comments are on PR #7");
    expect(review).toContain("1. src/a.ts:3 (@reviewer):\nRename this\n   https://github.com/acme/repo/pull/7#discussion_r1\n   Thread ID: T1");
    expect(review).toContain("2. (general) (@unknown reviewer):");

    const requested = formatReviewChangesRequestedMessage(pr, [{ id: "9", author: "lead", body: "Split this PR", url: "https://x/r9" }]);
    expect(requested).toContain("A changes-requested review from @lead is on PR #7");
    expect(requested).toContain("Review body:\nSplit this PR");
    expect(requested).toContain("Review ID: 9");
  });

  it("caps the message at the brief-safe limit", () => {
    const threads = Array.from({ length: 40 }, (_, index) => thread(`T${index}`, String(index), "x".repeat(700)));
    const message = formatReviewCommentsMessage(pr, threads);
    expect(message.length).toBeLessThanOrEqual(FEEDBACK_MESSAGE_MAX_CHARS + 20);
    expect(message.endsWith("… (truncated)")).toBe(true);
  });

  it("builds order-stable signatures", () => {
    expect(ciFailureSignature("sha", [build, { ...build, name: "a" }])).toBe(ciFailureSignature("sha", [{ ...build, name: "a" }, build]));
    expect(ciFailureSignature("sha", [build])).not.toBe(ciFailureSignature("other", [build]));
    expect(reviewCommentsSignature([thread("T1", "1"), thread("T2", "2")])).toBe(reviewCommentsSignature([thread("T2", "2"), thread("T1", "1")]));
    expect(changesRequestedSignature([{ id: "1", author: "", body: "", url: "" }, { id: "2", author: "", body: "", url: "" }]))
      .toBe(changesRequestedSignature([{ id: "2", author: "", body: "", url: "" }, { id: "1", author: "", body: "", url: "" }]));
  });

  it("tolerates malformed stored state", () => {
    expect(parseFeedbackNudgeState(null)).toEqual({});
    expect(parseFeedbackNudgeState("not json")).toEqual({});
    expect(parseFeedbackNudgeState('{"ci_failure":{"signature":"s","attempts":1,"queueItemId":null}}').ci_failure?.attempts).toBe(1);
  });
});

describe("planFeedbackNudges", () => {
  const none = new Set<never>();

  it("nudges once per CI signature and re-fires only when it changes", () => {
    const first = planFeedbackNudges({ observation: observation({ failedChecks: [build] }), previous: {}, liveKinds: none });
    expect(first.nudges.map((nudge) => nudge.kind)).toEqual(["ci_failure"]);
    expect(first.next.ci_failure).toEqual(expect.objectContaining({ attempts: 1, queueItemId: null }));
    expect(first.next.nonce).toBeTruthy();

    const same = planFeedbackNudges({ observation: observation({ failedChecks: [build] }), previous: first.next, liveKinds: none });
    expect(same.nudges).toEqual([]);
    expect(same.next.ci_failure).toEqual(first.next.ci_failure);

    const newSha = planFeedbackNudges({ observation: observation({ headSha: "b".repeat(40), failedChecks: [build] }), previous: first.next, liveKinds: none });
    expect(newSha.nudges.map((nudge) => nudge.kind)).toEqual(["ci_failure"]);
    expect(newSha.next.ci_failure?.attempts).toBe(1);

    const green = planFeedbackNudges({ observation: observation(), previous: first.next, liveKinds: none });
    expect(green.nudges).toEqual([]);
    expect(green.next.ci_failure).toBeUndefined();
  });

  it("retries an unchanged review signature only once the prior nudge is no longer live, up to three times", () => {
    const threads = [thread("T1", "1")];
    let state = planFeedbackNudges({ observation: observation({ unresolvedThreads: threads }), previous: {}, liveKinds: none });
    expect(state.nudges).toHaveLength(1);
    expect(state.nudges[0].paths).toEqual(["src/a.ts"]);

    const live = planFeedbackNudges({ observation: observation({ unresolvedThreads: threads }), previous: state.next, liveKinds: new Set(["review_comments"]) });
    expect(live.nudges).toEqual([]);

    state = planFeedbackNudges({ observation: observation({ unresolvedThreads: threads }), previous: state.next, liveKinds: none });
    expect(state.nudges[0]?.attempts).toBe(2);
    state = planFeedbackNudges({ observation: observation({ unresolvedThreads: threads }), previous: state.next, liveKinds: none });
    expect(state.nudges[0]?.attempts).toBe(3);
    const exhausted = planFeedbackNudges({ observation: observation({ unresolvedThreads: threads }), previous: state.next, liveKinds: none });
    expect(exhausted.nudges).toEqual([]);
    expect(exhausted.next.review_comments?.attempts).toBe(3);

    const newComment = planFeedbackNudges({ observation: observation({ unresolvedThreads: [...threads, thread("T2", "2")] }), previous: state.next, liveKinds: none });
    expect(newComment.nudges[0]?.attempts).toBe(1);
  });

  it("never nudges a merged or closed pull request", () => {
    expect(planFeedbackNudges({ observation: observation({ merged: true, failedChecks: [build] }), previous: {}, liveKinds: none }).nudges).toEqual([]);
    expect(planFeedbackNudges({ observation: observation({ state: "closed", failedChecks: [build] }), previous: {}, liveKinds: none }).nudges).toEqual([]);
  });
});

describe("mapPullRequestFeedback", () => {
  it("keeps failure-class checks, unresolved non-bot threads, and changes-requested reviews", () => {
    const facts = mapPullRequestFeedback({
      repository: {
        pullRequest: {
          number: 7, id: "PR_7", url: pr.url, state: "OPEN", merged: false, headRefOid: pr.headSha, reviewDecision: "CHANGES_REQUESTED",
          reviewThreads: { nodes: [
            { id: "T1", isResolved: false, isOutdated: false, comments: { nodes: [
              { databaseId: 1, url: "https://x/1", body: "Rename", path: "src/a.ts", line: 3, author: { __typename: "User", login: "reviewer" } },
              { databaseId: 2, url: "https://x/2", body: "bot noise", path: "src/a.ts", line: 3, author: { __typename: "Bot", login: "robothon" } },
            ] } },
            { id: "T2", isResolved: true, isOutdated: false, comments: { nodes: [{ databaseId: 3, url: "https://x/3", body: "Done", path: null, line: null, author: { __typename: "User", login: "reviewer" } }] } },
            { id: "T3", isResolved: false, isOutdated: true, comments: { nodes: [{ databaseId: 4, url: "https://x/4", body: "Old", path: null, line: null, author: { __typename: "User", login: "reviewer" } }] } },
          ] },
          latestOpinionatedReviews: { nodes: [
            { databaseId: 9, state: "CHANGES_REQUESTED", body: "Split", url: "https://x/r9", author: { __typename: "User", login: "lead" } },
            { databaseId: 10, state: "APPROVED", body: "", url: "https://x/r10", author: { __typename: "User", login: "other" } },
          ] },
          commits: { nodes: [{ commit: { oid: pr.headSha, statusCheckRollup: { contexts: { nodes: [
            { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/1" },
            { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/2" },
            { __typename: "CheckRun", name: "deploy", status: "IN_PROGRESS", conclusion: null, detailsUrl: "https://ci/3" },
            { __typename: "StatusContext", context: "coverage", state: "ERROR", targetUrl: "https://cov/1" },
            { __typename: "StatusContext", context: "docs", state: "SUCCESS", targetUrl: null },
          ] } } } }] },
        },
      },
    });
    expect(facts.reviewDecision).toBe("changes_requested");
    expect(facts.failedChecks).toEqual([{ name: "build", status: "failure", url: "https://ci/1" }, { name: "coverage", status: "error", url: "https://cov/1" }]);
    expect(facts.unresolvedThreads).toEqual([{ threadId: "T1", comments: [expect.objectContaining({ id: "1", author: "reviewer", path: "src/a.ts", line: 3 })] }]);
    expect(facts.changesRequested).toEqual([expect.objectContaining({ id: "9", author: "lead" })]);
  });

  it("rejects an incomplete payload", () => {
    expect(() => mapPullRequestFeedback({ repository: { pullRequest: null } })).toThrow();
  });
});

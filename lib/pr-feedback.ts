// PR feedback nudges — the pure half of lib/candidate-feedback.ts. Ported
// from agent-orchestrator's lifecycle/reactions.go (Apache-2.0): pre-digested
// messages so the agent never has to fetch GitHub itself, per-kind signatures
// for dedup, and a bounded attempt budget for review kinds. No I/O here so
// the dedup matrix is unit-testable without D1.
import type { QueueItemOrigin } from "./floor-types";

export type FeedbackKind = QueueItemOrigin;
export const FEEDBACK_KINDS: readonly FeedbackKind[] = ["ci_failure", "review_comments", "changes_requested"];

export type FeedbackNudgeRecord = { signature: string; attempts: number; queueItemId: string | null };
// Persisted as JSON in repository_candidates.feedback_nudges. The nonce makes
// every write unique so the DB layer's compare-and-set can tell its own
// write apart from a concurrent delivery's.
export type FeedbackNudgeState = Partial<Record<FeedbackKind, FeedbackNudgeRecord>> & { nonce?: string };

// 0 = re-nudge only when the signature changes (a new failing SHA or check
// set); review kinds also retry an unchanged signature up to this many times
// once the earlier nudge is no longer live.
export const FEEDBACK_MAX_ATTEMPTS: Record<FeedbackKind, number> = { ci_failure: 0, review_comments: 3, changes_requested: 3 };
// The brief's whole budget is 6,000 chars (lib/session-context.ts) and the
// nudge is rendered untruncated as the run's request, so it stays well under.
export const FEEDBACK_MESSAGE_MAX_CHARS = 3_000;
const BODY_MAX_CHARS = 800;

export type FeedbackPullRequest = { number: number; url: string; state: "open" | "closed"; merged: boolean; headSha: string };
export type FailedCheck = { name: string; status: string; url: string | null };
export type UnresolvedThreadComment = { id: string; author: string; body: string; path: string | null; line: number | null; url: string };
export type UnresolvedThread = { threadId: string; comments: UnresolvedThreadComment[] };
export type ChangesRequestedReview = { id: string; author: string; body: string; url: string };
export type PullRequestFeedbackObservation = FeedbackPullRequest & {
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  failedChecks: FailedCheck[];
  unresolvedThreads: UnresolvedThread[];
  changesRequested: ChangesRequestedReview[];
};

export type PlannedNudge = { kind: FeedbackKind; signature: string; message: string; paths: string[]; attempts: number };

export function parseFeedbackNudgeState(json: string | null): FeedbackNudgeState {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as FeedbackNudgeState) : {};
  } catch {
    return {};
  }
}

// Reviewer-controlled text lands in an agent's prompt; drop every C0/C1
// control character except newline, carriage return, and tab.
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

// A fence one backtick longer than the longest run inside the text, so
// embedded fences cannot break out (reactions.go markdownCodeFence).
export function markdownCodeFence(text: string): string {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    run = char === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function bound(message: string): string {
  return message.length > FEEDBACK_MESSAGE_MAX_CHARS ? `${message.slice(0, FEEDBACK_MESSAGE_MAX_CHARS)}\n… (truncated)` : message;
}

export function ciFailureSignature(headSha: string, checks: FailedCheck[]): string {
  return `ci:${headSha}:${checks.map((check) => check.name).sort().join("\0")}`;
}

export function reviewCommentsSignature(threads: UnresolvedThread[]): string {
  const parts = threads.flatMap((thread) => thread.comments.map((comment) => `${thread.threadId}\0${comment.id}`)).sort();
  return `review:${parts.join("\x01")}`;
}

export function changesRequestedSignature(reviews: ChangesRequestedReview[]): string {
  return `changes_requested:${reviews.map((review) => review.id).sort().join("\x01")}`;
}

const FOOTER = "Make the fixes in your working tree; openfloor publishes and integrates your result — never push, comment, or contact GitHub yourself.";

export function formatCIFailureMessage(pr: FeedbackPullRequest, checks: FailedCheck[]): string {
  const lines = [`CI is failing on PR #${pr.number} (${stripControlChars(pr.url)}) at ${pr.headSha.slice(0, 12)}.`, ""];
  for (const check of checks) {
    const name = stripControlChars(check.name).trim() || "unnamed check";
    const status = stripControlChars(check.status).trim() || "failed";
    lines.push(`Failed: ${name} (${status})`);
    if (check.url) lines.push(`Failure URL: ${stripControlChars(check.url)}`);
    lines.push("");
  }
  lines.push(`${FOOTER} You cannot fetch CI logs from the sandbox: work from the check names, the failure URLs, and the repository's own test and lint configuration.`);
  return bound(lines.join("\n"));
}

export function formatReviewCommentsMessage(pr: FeedbackPullRequest, threads: UnresolvedThread[]): string {
  const comments = threads.flatMap((thread) => thread.comments.map((comment) => ({ ...comment, threadId: thread.threadId })));
  const lines = [`The following ${comments.length} unresolved review comment${comments.length === 1 ? "" : "s"} are on PR #${pr.number} (${stripControlChars(pr.url)}) as of just now. You should not need to re-fetch this data.`, ""];
  comments.forEach((comment, index) => {
    const location = comment.path ? `${stripControlChars(comment.path)}${comment.line ? `:${comment.line}` : ""}` : "(general)";
    const author = stripControlChars(comment.author).trim() || "unknown reviewer";
    lines.push(`${index + 1}. ${location} (@${author}):`);
    lines.push(clip(stripControlChars(comment.body), BODY_MAX_CHARS));
    lines.push(`   ${stripControlChars(comment.url)}`);
    lines.push(`   Thread ID: ${stripControlChars(comment.threadId)}`);
    lines.push("");
  });
  lines.push(`Address each comment. ${FOOTER} Reviewers resolve threads on GitHub themselves.`);
  return bound(lines.join("\n"));
}

export function formatReviewChangesRequestedMessage(pr: FeedbackPullRequest, reviews: ChangesRequestedReview[]): string {
  const lines: string[] = [];
  for (const review of reviews) {
    const author = stripControlChars(review.author).trim() || "unknown reviewer";
    lines.push(`A changes-requested review from @${author} is on PR #${pr.number} (${stripControlChars(pr.url)}).`);
    const body = clip(stripControlChars(review.body), BODY_MAX_CHARS);
    if (body) lines.push("", "Review body:", body);
    lines.push("", `Review URL: ${stripControlChars(review.url)}`, `Review ID: ${stripControlChars(review.id)}`, "");
  }
  lines.push(`Address the requested changes. ${FOOTER}`);
  return bound(lines.join("\n"));
}

// Decides which nudges to send now. An unchanged signature never re-fires a
// CI nudge; review kinds re-fire an unchanged signature only once the prior
// nudge item is no longer live and while under the attempt budget. A changed
// signature always fires and resets the budget. Kinds whose facts are gone
// (CI green again, threads resolved) drop out of the state.
export function planFeedbackNudges(input: {
  observation: PullRequestFeedbackObservation;
  previous: FeedbackNudgeState;
  liveKinds: ReadonlySet<FeedbackKind>;
}): { nudges: PlannedNudge[]; next: FeedbackNudgeState } {
  const { observation, previous, liveKinds } = input;
  const next: FeedbackNudgeState = { nonce: crypto.randomUUID() };
  const nudges: PlannedNudge[] = [];
  if (observation.merged || observation.state !== "open") return { nudges, next };

  const candidates: Array<{ kind: FeedbackKind; signature: string; message: string; paths: string[] } | null> = [
    observation.failedChecks.length > 0
      ? { kind: "ci_failure", signature: ciFailureSignature(observation.headSha, observation.failedChecks), message: formatCIFailureMessage(observation, observation.failedChecks), paths: [] }
      : null,
    observation.unresolvedThreads.length > 0
      ? {
          kind: "review_comments",
          signature: reviewCommentsSignature(observation.unresolvedThreads),
          message: formatReviewCommentsMessage(observation, observation.unresolvedThreads),
          paths: [...new Set(observation.unresolvedThreads.flatMap((thread) => thread.comments.map((comment) => comment.path)).filter((path): path is string => Boolean(path)))],
        }
      : null,
    observation.changesRequested.length > 0
      ? { kind: "changes_requested", signature: changesRequestedSignature(observation.changesRequested), message: formatReviewChangesRequestedMessage(observation, observation.changesRequested), paths: [] }
      : null,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const prior = previous[candidate.kind];
    const same = prior?.signature === candidate.signature;
    const max = FEEDBACK_MAX_ATTEMPTS[candidate.kind];
    if (same && (max === 0 || liveKinds.has(candidate.kind) || (prior?.attempts ?? 0) >= max)) {
      next[candidate.kind] = prior;
      continue;
    }
    const attempts = same ? (prior?.attempts ?? 0) + 1 : 1;
    next[candidate.kind] = { signature: candidate.signature, attempts, queueItemId: prior?.queueItemId ?? null };
    nudges.push({ ...candidate, attempts });
  }
  return { nudges, next };
}

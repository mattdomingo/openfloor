// PR feedback nudges: after a qualifying GitHub webhook, re-observe the
// candidate PR's failing checks, unresolved review threads, and
// changes-requested reviews, then queue pre-digested prompts for the agent
// whose integrated run is responsible. Ported in spirit from
// agent-orchestrator's lifecycle reactions (Apache-2.0); the queue is the
// delivery channel here instead of a live terminal.
import { getGitHubAppConfig } from "@/db";
import {
  getCandidateFeedbackContext,
  recordFeedbackNudges,
  resolveFeedbackAgent,
  type FeedbackNudgeEntry,
} from "@/db/candidate-feedback";
import { touchRepositoryReview } from "@/db/repositories";
import { getPullRequestFeedback, type GitHubPullRequestFeedback } from "@/lib/github";
import { FEEDBACK_KINDS, parseFeedbackNudgeState, planFeedbackNudges } from "@/lib/pr-feedback";

export async function applyCandidatePullRequestFeedback(sessionId: string): Promise<{ revision: number; nudged: boolean }> {
  const context = await getCandidateFeedbackContext(sessionId);
  if (!context) return { revision: await touchRepositoryReview(sessionId), nudged: false };
  let observation: GitHubPullRequestFeedback;
  try {
    observation = await getPullRequestFeedback(getGitHubAppConfig(), context.installationId, context.repository, context.pullRequestNumber);
  } catch (error) {
    // The delivery is still acknowledged (GitHub does not retry on its own);
    // the next qualifying delivery re-observes from scratch.
    console.error(`PR feedback observation failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return { revision: await touchRepositoryReview(sessionId), nudged: false };
  }
  const previous = parseFeedbackNudgeState(context.feedbackNudges);
  const plan = planFeedbackNudges({ observation, previous, liveKinds: context.liveKinds });
  const stateChanged = FEEDBACK_KINDS.some((kind) => JSON.stringify(previous[kind] ?? null) !== JSON.stringify(plan.next[kind] ?? null));
  if (plan.nudges.length === 0 && !stateChanged && observation.reviewDecision === context.reviewDecision) {
    return { revision: await touchRepositoryReview(sessionId), nudged: false };
  }
  const entries: FeedbackNudgeEntry[] = [];
  for (const nudge of plan.nudges) {
    const responsible = await resolveFeedbackAgent(sessionId, context.candidateId, nudge.kind === "ci_failure" ? null : nudge.paths);
    entries.push({
      nudge,
      agentId: responsible?.agentId ?? null,
      sourceRunId: responsible?.runId ?? null,
      reuseQueueItemId: context.reusableItems.get(nudge.kind) ?? null,
    });
  }
  const result = await recordFeedbackNudges(context, entries, plan.next, observation.reviewDecision);
  return { revision: result.revision, nudged: result.created && entries.length > 0 };
}

// Decides whether a new agent run may resume an earlier run's provider
// thread (Codex `resumeThread`, Claude Agent SDK `resume`). Pure so the
// eligibility matrix is unit-testable without D1; createAgentRun feeds it
// the agent's recent runs on the same candidate, newest first.

export const RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ResumeCandidateRow = {
  id: string;
  queueItemId: string;
  attempt: number;
  model: string;
  kind: "reply" | null;
  providerThreadId: string | null;
  sessionStoreKey: string | null;
  completedAt: number | null;
  createdAt: number;
};

export type ResumeTarget = {
  queueItemId: string;
  model: string;
  kind: "reply" | null;
  // A system-originated follow-up (e.g. a PR feedback nudge) names the run
  // it follows; that run's thread is resumable even though the queue item
  // differs.
  sourceRunId?: string | null;
  now: number;
};

export function pickResumeSource(rows: ResumeCandidateRow[], target: ResumeTarget): ResumeCandidateRow | null {
  for (const row of rows) {
    if (!row.providerThreadId || !row.sessionStoreKey) continue;
    if (row.queueItemId !== target.queueItemId && row.id !== target.sourceRunId) continue;
    // OpenAI replays encrypted reasoning items that are model-bound; one
    // rule for every provider is simpler than per-provider exceptions.
    if (row.model !== target.model) continue;
    // A reply thread was told "do not edit files"; a task thread was not.
    if (row.kind !== target.kind) continue;
    if (target.now - (row.completedAt ?? row.createdAt) > RESUME_MAX_AGE_MS) continue;
    return row;
  }
  return null;
}

import type { AgentRunKind, AgentRunStatus } from "./floor-types";

/**
 * States from which an AgentRunWorkflow invocation must never resume work.
 * A reply's `ready` is terminal because its answer has already been persisted;
 * a task's `ready` still has publication and integration left to do.
 */
export function isAgentRunWorkflowTerminal(run: { status: AgentRunStatus; kind: AgentRunKind; completion?: "no_changes" | null }): boolean {
  return ["integrated", "conflicted", "failed", "cancelled"].includes(run.status)
    || ((run.kind === "reply" || run.completion === "no_changes") && run.status === "ready");
}

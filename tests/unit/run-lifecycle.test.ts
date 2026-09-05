import { describe, expect, it } from "vitest";
import type { AgentRunKind, AgentRunStatus } from "@/lib/floor-types";
import { isAgentRunWorkflowTerminal } from "@/lib/run-lifecycle";

describe("agent run workflow lifecycle", () => {
  it("keeps no-change task completion terminal", () => {
    expect(isAgentRunWorkflowTerminal({ status: "ready", kind: null, completion: "no_changes" })).toBe(true);
  });
  it.each([
    ["integrated", null],
    ["conflicted", null],
    ["failed", null],
    ["cancelled", null],
    ["ready", "reply"],
  ] satisfies Array<[AgentRunStatus, AgentRunKind]>)("treats %s %s as terminal", (status, kind) => {
    expect(isAgentRunWorkflowTerminal({ status, kind })).toBe(true);
  });

  it.each([
    ["provisioning", null],
    ["running", null],
    ["checking", null],
    ["ready", null],
    ["publishing", null],
    ["published", null],
    ["integrating", null],
    ["cancel_requested", null],
  ] satisfies Array<[AgentRunStatus, AgentRunKind]>)("allows %s %s to resume", (status, kind) => {
    expect(isAgentRunWorkflowTerminal({ status, kind })).toBe(false);
  });
});

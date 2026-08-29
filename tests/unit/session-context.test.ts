import { describe, expect, it } from "vitest";
import {
  renderSessionContext,
  SESSION_CONTEXT_LIMITS,
  type SessionContextRun,
  type SessionContextSnapshot,
  type SessionContextViewer,
} from "@/lib/session-context";

const viewer: SessionContextViewer = {
  agentId: "self",
  agentName: "Builder",
  agentRole: "Backend agent",
  agentTask: "Implements API routes.",
  runId: "run-self",
  queueItemId: "queue-self",
  attempt: 1,
  candidateSha: "sha-pinned",
};

function baseSnapshot(overrides: Partial<SessionContextSnapshot> = {}): SessionContextSnapshot {
  return {
    session: { title: "Ship the API", objective: "Land the health check endpoint." },
    repository: { fullName: "acme/service", baseBranch: "main" },
    candidate: { branchName: "openfloor/abc123/candidate/ship-def456", sha: "sha-candidate", pullRequestNumber: null },
    agents: [{ id: "self", name: "Builder", role: "Backend agent", task: "Implements API routes.", ownerName: "Owner Example" }],
    assignments: [],
    queue: [{ id: "queue-self", position: 1, status: "running", agentName: "Builder", assignedReason: null, origin: null, prompts: [{ authorName: "Owner Example", text: "Add /healthz" }] }],
    integratedRuns: [],
    inFlightRuns: [],
    blockedRuns: [],
    priorAttempts: [],
    chat: [],
    sharedFiles: [],
    ...overrides,
  };
}

function sectionOrder(text: string, titles: string[]): number[] {
  return titles.map((title) => text.indexOf(`## ${title}`));
}

describe("renderSessionContext", () => {
  it("renders every section in the documented priority order and counts the viewer among the floor", () => {
    const snapshot = baseSnapshot({
      agents: [
        { id: "self", name: "Builder", role: "Backend agent", task: "Implements API routes.", ownerName: "Owner Example" },
        { id: "other", name: "Reviewer", role: "Review agent", task: "Reviews pull requests.", ownerName: "Member Example" },
      ],
      assignments: [{ userName: "Member Example", task: "Coordinate the release" }],
    });
    const text = renderSessionContext(snapshot, viewer);

    expect(text).toContain("You are Builder — Backend agent — one of 2 agents on this floor.");
    expect(text).toContain('Session: "Ship the API" · Objective: Land the health check endpoint.');
    expect(text).toContain("Repository: acme/service · candidate openfloor/abc123/candidate/ship-def456@sha-pinned → base main");

    const titles = ["Your request", "Who else is on this floor", "Already integrated", "Running right now", "Waiting in the queue", "Blocked or failed earlier", "Recent team chat", "How to work on this floor"];
    const indices = sectionOrder(text, titles);
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));

    // "Who else" lists the other agent and the human assignment, never the viewer's own agent.
    expect(text).toContain("Reviewer (Review agent, owned by Member Example)");
    expect(text).toContain("Member Example: Coordinate the release");
    expect(text).not.toContain("- Builder (Backend agent, owned by Owner Example)");
  });

  it("renders empty sections honestly instead of omitting them", () => {
    const text = renderSessionContext(baseSnapshot(), viewer);
    expect(text).toContain("No other agents or member assignments on this floor.");
    expect(text).toContain("Nothing has integrated into this candidate yet.");
    expect(text).toContain("No other runs are in flight right now.");
    expect(text).toContain("The queue is otherwise empty.");
    expect(text).toContain("No blocked or failed runs.");
    expect(text).toContain("No recent team chat.");
  });

  it("marks the viewer's own request and lists prior attempts with their conflict reasons", () => {
    const snapshot = baseSnapshot({ priorAttempts: [{ attempt: 1, status: "conflicted", conflictReason: "GitHub reported a merge conflict." }] });
    const viewerSecondAttempt: SessionContextViewer = { ...viewer, attempt: 2 };
    const text = renderSessionContext(snapshot, viewerSecondAttempt);
    expect(text).toContain("Your standing responsibility as Builder: Implements API routes.");
    expect(text).toContain("Queue position: #1 · Attempt: 2");
    expect(text).toContain("Owner Example: Add /healthz");
    expect(text).toContain("Prior attempts on this same request:");
    expect(text).toContain("Attempt 1: conflicted — GitHub reported a merge conflict.");
  });

  it("caps a section at its documented limit and leaves an explicit remaining count", () => {
    const chat = Array.from({ length: SESSION_CONTEXT_LIMITS.chatMessages + 3 }, (_, index) => ({ authorName: "Member Example", text: `message ${index}` }));
    const text = renderSessionContext(baseSnapshot({ chat }), viewer);
    // Since message 3..8 are the newest 6 messages, they fill the slots
    expect(text).toContain("message 3");
    expect(text).toContain(`message ${SESSION_CONTEXT_LIMITS.chatMessages + 2}`);
    expect(text).not.toContain("message 0");
    expect(text).toContain("(3 more not shown)");
  });

  it("prioritizes messages that mention the agent in team chat", () => {
    const chat = [
      { authorName: "Member 1", text: "general chatter 1" },
      { authorName: "Member 2", text: "hey @Builder please check this endpoint" },
      { authorName: "Member 3", text: "general chatter 2" },
      { authorName: "Member 4", text: "general chatter 3" },
      { authorName: "Member 5", text: "general chatter 4" },
      { authorName: "Member 6", text: "general chatter 5" },
      { authorName: "Member 7", text: "general chatter 6" },
      { authorName: "Member 8", text: "general chatter 7" },
    ];
    const text = renderSessionContext(baseSnapshot({ chat }), viewer);
    expect(text).toContain("hey @Builder please check this endpoint");
  });

  it("drops whole lower-priority sections with a budget marker when the brief exceeds the character budget, keeping higher-priority sections intact", () => {
    const longPrompt = [{ authorName: "Owner Example", text: "x".repeat(SESSION_CONTEXT_LIMITS.promptChars) }];
    const run = (id: string, status: string): SessionContextRun => ({
      id, agentName: "Other", status, summary: null, conflictReason: "y".repeat(SESSION_CONTEXT_LIMITS.summaryChars),
      prompts: longPrompt, files: [], recentEdits: Array.from({ length: SESSION_CONTEXT_LIMITS.editsPerRun }, () => "e".repeat(SESSION_CONTEXT_LIMITS.editChars)),
    });

    // Push every low-priority section to its documented cap so the assembled
    // brief is guaranteed to exceed the budget by a wide margin, regardless
    // of exact per-line overhead. Priority 1 (chat) is always dropped first;
    // the deliberately tiny, high-priority "already integrated" content
    // (priority 5) must survive even though several sections were dropped.
    const chat = Array.from({ length: SESSION_CONTEXT_LIMITS.chatMessages }, (_, index) => ({ authorName: "Member Example", text: "z".repeat(SESSION_CONTEXT_LIMITS.chatChars) + index }));
    const blockedRuns = Array.from({ length: SESSION_CONTEXT_LIMITS.blockedRuns }, (_, index) => run(`blocked-${index}`, "conflicted"));
    const inFlightRuns = Array.from({ length: SESSION_CONTEXT_LIMITS.inFlightRuns }, (_, index) => run(`inflight-${index}`, "running"));
    const queue = [
      baseSnapshot().queue[0],
      ...Array.from({ length: SESSION_CONTEXT_LIMITS.queuedItems }, (_, index) => ({ id: `queue-${index}`, position: index + 2, status: "queued", agentName: null, assignedReason: null, origin: null, prompts: longPrompt })),
    ];
    const integratedRuns: SessionContextRun[] = [{ id: "integrated-1", agentName: "Other", status: "integrated", summary: "The real integrated summary that must survive.", conflictReason: null, prompts: [], files: ["src/index.ts"], recentEdits: [] }];

    const text = renderSessionContext(baseSnapshot({ chat, blockedRuns, inFlightRuns, queue, integratedRuns }), viewer);

    // Chat is the lowest-priority section and is always dropped first once
    // the brief is over budget.
    expect(text).toContain("## Recent team chat\n(omitted — over context budget)");
    expect(text).not.toContain("z".repeat(50));
    // "Your request" and the header are never dropped.
    expect(text).toContain("## Your request");
    expect(text).toContain("You are Builder");
    // The tiny, higher-priority integrated section survives the cascade.
    expect(text).toContain("The real integrated summary that must survive.");
    expect(text).toContain("src/index.ts");
  });
});

describe("renderSessionContext thread resume", () => {
  it("opens a resumed thread with a short preamble and leaves fresh runs untouched", () => {
    const fresh = renderSessionContext(baseSnapshot(), viewer);
    expect(fresh).not.toContain("## Continuing your earlier thread");

    const resumed = renderSessionContext(baseSnapshot(), { ...viewer, attempt: 2, resume: { fromAttempt: 1, fromStatus: "failed" } });
    expect(resumed).toContain("## Continuing your earlier thread");
    expect(resumed).toContain("from attempt 1 (failed)");
    expect(resumed).toContain("checked out fresh at candidate sha-pinned");
    expect(resumed.indexOf("## Continuing your earlier thread")).toBeLessThan(resumed.indexOf("## Your request"));
    expect(resumed.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMITS.totalChars);
  });
});

describe("renderSessionContext PR feedback nudges", () => {
  it("renders a feedback nudge past the ordinary prompt cap while staying inside the brief budget", () => {
    const nudge = `CI is failing on PR #7.\n${"Failed: check (failure)\n".repeat(60)}`;
    const snapshot = baseSnapshot({
      queue: [{ id: "queue-self", position: 1, status: "running", agentName: "Builder", assignedReason: null, origin: "ci_failure", prompts: [{ authorName: "Owner Example", text: nudge }] }],
    });
    const text = renderSessionContext(snapshot, viewer);
    expect(nudge.length).toBeGreaterThan(SESSION_CONTEXT_LIMITS.promptChars);
    expect(text).toContain(nudge.trim());
    expect(text.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMITS.totalChars);

    const human = renderSessionContext(baseSnapshot({
      queue: [{ id: "queue-self", position: 1, status: "running", agentName: "Builder", assignedReason: null, origin: null, prompts: [{ authorName: "Owner Example", text: nudge }] }],
    }), viewer);
    expect(human).not.toContain(nudge.trim());
  });
});

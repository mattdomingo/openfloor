export type AgentStatus = "running" | "reviewing" | "blocked" | "complete";
export type AgentAutonomy = "suggest" | "auto-edit" | "autopilot";
export type PanelId = "brief" | "floor" | "repository";
export type RailId = Exclude<PanelId, "floor">;
export type CenterMode = "activity" | "codebase";
export type AgentLayout = "focus" | "all";
export type DockMode = "focus" | "persistent" | "live";
export type FileState = "modified" | "attention" | "pending";
export type CheckState = "passed" | "waiting" | "failed";
export type StepState = "done" | "active" | "todo";

export type Agent = {
  id: string;
  name: string;
  role: string;
  task: string;
  owner: string;
  color: string;
  status: AgentStatus;
  progress: number;
  detail: string;
  files: string[];
  branch: string;
  time: string;
  model: string;
  autonomy: AgentAutonomy;
  baseBranch: string;
  checks: string[];
  reviewRequired: boolean;
};

/* What the create-agent form collects before an agent joins the floor. */
export type AgentDraft = {
  name: string;
  roleId: string;
  task: string;
  owner: string;
  color: string;
  model: string;
  autonomy: AgentAutonomy;
  baseBranch: string;
  branch: string;
  scope: string;
  checks: string[];
  reviewRequired: boolean;
};

export type Assignment = {
  id: string;
  name: string;
  initials: string;
  tone: string;
  agent: string;
  task: string;
  state: string;
  stateTone: string;
};

export type ChangedFile = {
  path: string;
  agent: string;
  add: number;
  del: number;
  state: FileState;
};

export type Check = {
  id: string;
  name: string;
  detail: string;
  state: CheckState;
};

export type Draft = {
  id: string;
  name: string;
  initials: string;
  tone: string;
  text: string;
};

export type Step = { label: string; state: StepState };

export const sessionTitle = "Realtime presence";

export const defaultGoal =
  "Ship realtime presence and agent activity with a shared event model, isolated agent worktrees, and a reviewable combined repository state.";

export const sessionFacts = {
  branch: "openfloor/session-presence",
  started: "Started 24 min ago",
  progress: 62,
};

export const participants = [
  { id: "matt", name: "Matt", initials: "M", tone: "matt" },
  { id: "ryan", name: "Ryan", initials: "R", tone: "ryan" },
  { id: "ali", name: "Ali", initials: "A", tone: "ali" },
];

/* Role presets seed the rest of the form: colour, model, scope, and opening step. */
export const agentRolePresets = [
  {
    id: "backend",
    label: "Backend worker",
    color: "#c9552f",
    model: "frontier-xl",
    scope: "server/",
    detail: "Reading the task contract and preparing an isolated worktree",
  },
  {
    id: "frontend",
    label: "Frontend worker",
    color: "#b8862a",
    model: "frontier",
    scope: "app/session/",
    detail: "Mapping the task to the session view before editing",
  },
  {
    id: "test",
    label: "Test worker",
    color: "#4a7d68",
    model: "swift",
    scope: "tests/",
    detail: "Reading existing coverage to find the gaps worth closing",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    color: "#4e6f8a",
    model: "frontier",
    scope: "server/\napp/",
    detail: "Waiting for the first patch to review read-only",
  },
  {
    id: "docs",
    label: "Docs worker",
    color: "#8b6bb1",
    model: "swift",
    scope: "docs/\nREADME.md",
    detail: "Collecting the decisions that need to be written down",
  },
];

export const agentModels = [
  { id: "frontier-xl", label: "Frontier XL", detail: "Deepest reasoning · protocol and schema design" },
  { id: "frontier", label: "Frontier", detail: "Balanced default for feature work" },
  { id: "swift", label: "Swift", detail: "Fast mechanical edits, refactors, and scaffolding" },
];

export const autonomyOptions: { value: AgentAutonomy; label: string; detail: string }[] = [
  { value: "suggest", label: "Suggest only", detail: "Proposes diffs and waits for you to apply each one." },
  { value: "auto-edit", label: "Auto-edit worktree", detail: "Edits its own worktree freely, asks before pushing." },
  { value: "autopilot", label: "Autopilot", detail: "Runs until checks pass, then requests review." },
];

export const checkOptions = [
  { id: "types", label: "Type check" },
  { id: "unit", label: "Unit tests" },
  { id: "lint", label: "Lint" },
  { id: "integration", label: "Integration suite" },
];

export const agentColorOptions = [
  { value: "#c9552f", label: "Clay" },
  { value: "#b8862a", label: "Ochre" },
  { value: "#4a7d68", label: "Moss" },
  { value: "#4e6f8a", label: "Slate" },
  { value: "#8b6bb1", label: "Plum" },
];

export const baseBranchOptions = [sessionFacts.branch, "main"];

const agentNamePool = ["Orbit", "Vector", "Quill", "Cinder", "Harbor", "Lumen", "Pilot"];

export const initialAgents: Agent[] = [
  {
    id: "atlas",
    name: "Atlas",
    role: "Backend worker",
    task: "Session event protocol",
    owner: "Matt",
    color: "#c9552f",
    status: "running",
    progress: 72,
    detail: "Normalizing task and agent lifecycle events",
    files: ["server/events/schema.ts", "server/session/reducer.ts"],
    branch: "of/atlas-session-events",
    time: "12m",
    model: "Frontier XL",
    autonomy: "auto-edit",
    baseBranch: sessionFacts.branch,
    checks: ["types", "unit"],
    reviewRequired: true,
  },
  {
    id: "nova",
    name: "Nova",
    role: "Frontend worker",
    task: "Agent activity cards",
    owner: "Ryan",
    color: "#b8862a",
    status: "running",
    progress: 58,
    detail: "Wiring live status transitions to the session view",
    files: ["app/session/AgentCard.tsx", "app/session/activity.css"],
    branch: "of/nova-agent-cards",
    time: "8m",
    model: "Frontier",
    autonomy: "autopilot",
    baseBranch: sessionFacts.branch,
    checks: ["types", "lint"],
    reviewRequired: true,
  },
  {
    id: "sentry",
    name: "Sentry",
    role: "Test worker",
    task: "Event reducer coverage",
    owner: "Matt",
    color: "#4a7d68",
    status: "blocked",
    progress: 34,
    detail: "Waiting on event payload shape from Atlas",
    files: ["tests/session-reducer.test.ts"],
    branch: "of/sentry-reducer-tests",
    time: "6m",
    model: "Swift",
    autonomy: "autopilot",
    baseBranch: sessionFacts.branch,
    checks: ["types", "unit", "lint"],
    reviewRequired: false,
  },
  {
    id: "proof",
    name: "Proof",
    role: "Reviewer",
    task: "Integrated change review",
    owner: "Ali",
    color: "#4e6f8a",
    status: "reviewing",
    progress: 41,
    detail: "Checking task boundaries and combined type safety",
    files: ["server/session/reducer.ts", "app/session/AgentCard.tsx"],
    branch: "of/proof-integrated-review",
    time: "4m",
    model: "Frontier",
    autonomy: "suggest",
    baseBranch: sessionFacts.branch,
    checks: ["types"],
    reviewRequired: false,
  },
];

export const initialAssignments: Assignment[] = [
  {
    id: "matt",
    name: "Matt",
    initials: "M",
    tone: "matt",
    agent: "Atlas · Backend",
    task: "Define the session event protocol and reconnect replay contract.",
    state: "Active",
    stateTone: "running",
  },
  {
    id: "ryan",
    name: "Ryan",
    initials: "R",
    tone: "ryan",
    agent: "Nova · Frontend",
    task: "Build agent activity cards and wire live status transitions.",
    state: "Active",
    stateTone: "running",
  },
  {
    id: "ali",
    name: "Ali",
    initials: "A",
    tone: "ali",
    agent: "Proof · Reviewer",
    task: "Review integrated changes and resolve status naming inconsistencies.",
    state: "Review",
    stateTone: "review",
  },
];

export const scopeConflict = {
  path: "server/session/reducer.ts",
  claimants: "Atlas and Proof",
  recommendation: "The orchestrator recommends keeping Atlas as owner and making Proof's pass read-only.",
};

export const latestDecision = {
  statement: "WebSocket reconnects replay from the last acknowledged event.",
  attribution: "Decided by Matt · 8m ago",
};

export const changedFiles: ChangedFile[] = [
  { path: "server/events/schema.ts", agent: "Atlas", add: 84, del: 6, state: "modified" },
  { path: "server/session/reducer.ts", agent: "Atlas · Proof", add: 126, del: 18, state: "attention" },
  { path: "app/session/AgentCard.tsx", agent: "Nova · Proof", add: 192, del: 12, state: "modified" },
  { path: "app/session/activity.css", agent: "Nova", add: 77, del: 4, state: "modified" },
  { path: "tests/session-reducer.test.ts", agent: "Sentry", add: 63, del: 0, state: "pending" },
];

export const repoSummary = { files: 5, additions: 542, deletions: 40 };

export const checks: Check[] = [
  { id: "types", name: "Type check", detail: "Passed · 32s", state: "passed" },
  { id: "unit", name: "Unit tests", detail: "48 passed · 1m 14s", state: "passed" },
  { id: "lint", name: "Lint", detail: "No warnings · 18s", state: "passed" },
  { id: "integration", name: "Integration suite", detail: "Waiting on OF-19", state: "waiting" },
];

export const integrationOrder = ["Atlas", "Nova", "Sentry"];

export const drafts: Draft[] = [
  {
    id: "matt",
    name: "Matt",
    initials: "M",
    tone: "matt",
    text: "Atlas, keep the event envelope backwards compatible with reconnect replay.",
  },
  {
    id: "ryan",
    name: "Ryan",
    initials: "R",
    tone: "ryan",
    text: "Nova, add the blocked state before you prepare the frontend patch.",
  },
  {
    id: "ali",
    name: "Ali",
    initials: "A",
    tone: "ali",
    text: "I'm checking whether the reducer and card agree on status naming…",
  },
];

export const codeByAgent: Record<string, { path: string; lines: string[] }> = {
  atlas: {
    path: "server/events/schema.ts",
    lines: [
      "export type SessionEvent<T extends EventType> = {",
      "  eventId: string;",
      "  sessionId: string;",
      "  sequence: number;",
      "  occurredAt: string;",
      "  actor: EventActor;",
      "  type: T;",
      "  payload: EventPayloadMap[T];",
      "  causationId?: string;",
      "};",
      "",
      "export function reduceSession(state, event) {",
      "  return reducers[event.type](state, event.payload);",
      "}",
    ],
  },
  nova: {
    path: "app/session/AgentCard.tsx",
    lines: [
      "export function AgentCard({ agent, onFocus }) {",
      "  return (",
      "    <article data-status={agent.status}>",
      "      <AgentIdentity agent={agent} />",
      "      <Progress value={agent.progress} />",
      "      <CurrentStep>{agent.currentStep}</CurrentStep>",
      "      <OwnedFiles files={agent.ownedPaths} />",
      "      <button onClick={onFocus}>Open worktree</button>",
      "    </article>",
      "  );",
      "}",
    ],
  },
  sentry: {
    path: "tests/session-reducer.test.ts",
    lines: [
      'describe("session event reducer", () => {',
      '  it("replays events in sequence order", () => {',
      "    const session = replay(fixture.events);",
      "",
      "    expect(session.tasks.active).toHaveLength(2);",
      '    expect(session.agents.sentry.status).toBe("blocked");',
      "    expect(session.lastSequence).toBe(42);",
      "  });",
      "});",
    ],
  },
  proof: {
    path: "server/session/reducer.ts",
    lines: [
      'case "agent.status_changed": {',
      "  const agent = state.agents[event.payload.agentId];",
      "",
      "  return updateAgent(state, agent.id, {",
      "    status: event.payload.status,",
      "    currentStep: event.payload.currentStep,",
      "    updatedAt: event.occurredAt,",
      "  });",
      "}",
    ],
  },
};

const planLabels = ["Read contract", "Claim scope", "Implement", "Run checks", "Prepare patch"];

export function planSteps(agent: Agent): Step[] {
  const activeIndex =
    agent.status === "complete" ? planLabels.length : agent.progress < 20 ? 1 : agent.progress < 75 ? 2 : agent.progress < 90 ? 3 : 4;

  return planLabels.map((label, index) => ({
    label,
    state: index < activeIndex ? "done" : index === activeIndex ? "active" : "todo",
  }));
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* Worktree branch name in the shape the session already uses: of/<name>-<task>. */
export function agentBranchName(name: string, task: string): string {
  const parts = [slug(name), slug(task).split("-").slice(0, 3).join("-")].filter(Boolean);

  return `of/${parts.join("-") || "new-agent"}`;
}

export function suggestAgentName(taken: Agent[]): string {
  const used = new Set(taken.map((agent) => agent.name.toLowerCase()));
  const free = agentNamePool.find((name) => !used.has(name.toLowerCase()));

  return free ?? `Agent ${taken.length + 1}`;
}

export function agentFromDraft(draft: AgentDraft, sequence: number): Agent {
  const preset = agentRolePresets.find((option) => option.id === draft.roleId) ?? agentRolePresets[0];
  const model = agentModels.find((option) => option.id === draft.model) ?? agentModels[1];
  const files = draft.scope
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    id: `agent-${sequence}`,
    name: draft.name.trim() || preset.label,
    role: preset.label,
    task: draft.task.trim(),
    owner: draft.owner,
    color: draft.color,
    status: draft.roleId === "reviewer" ? "reviewing" : "running",
    progress: 4,
    detail: preset.detail,
    files: files.length > 0 ? files : ["No scope claimed yet"],
    branch: draft.branch.trim() || agentBranchName(draft.name, draft.task),
    time: "now",
    model: model.label,
    autonomy: draft.autonomy,
    baseBranch: draft.baseBranch,
    checks: draft.checks,
    reviewRequired: draft.reviewRequired,
  };
}

export function autonomyLabel(autonomy: AgentAutonomy): string {
  return autonomyOptions.find((option) => option.value === autonomy)?.label ?? autonomy;
}

export function statusTone(status: AgentStatus): string {
  if (status === "blocked") return "blocked";
  if (status === "reviewing") return "review";
  return "running";
}

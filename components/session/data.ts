export type AgentStatus = "writing" | "needs-input" | "blocked" | "idle" | "reviewing" | "complete";
export type AgentAutonomy = "suggest" | "auto-edit" | "autopilot";
export type AgentKind = "worker" | "orchestrator" | "qa";
export type PanelId = "brief" | "floor" | "queue";
export type RailId = Exclude<PanelId, "floor">;
export type CenterMode = "activity" | "codebase";
export type AgentLayout = "focus" | "all";
export type DockMode = "focus" | "persistent" | "live";
export type WorkspaceScreen = "workspace" | "review";
export type QueueScope = "mine" | "team";
export type QueueOrderMode = "auto" | "manual";
export type QueueStatus = "queued" | "waiting";
export type FileState = "modified" | "attention" | "pending";
export type CheckState = "passed" | "waiting" | "failed";
export type StepState = "done" | "active" | "todo";
export type ReviewStatus = "awaiting" | "changes-requested" | "approved";
export type TeamPanelView = "goals" | "chat";

export type TeamChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  authorTone: string;
  text: string;
  time: string;
};

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
  kind: AgentKind;
  /* Shown in the focus-view callout for needs-input, blocked, and idle. */
  alert?: string;
  /* Set only on Q's ephemeral sub-agents, pointing back at "q". */
  parentId?: string;
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

export type QueueItem = {
  id: string;
  prompt: string;
  author: string;
  authorTone: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  position: number;
  status: QueueStatus;
  queuedAt: string;
};

export type ReviewCheck = {
  id: string;
  name: string;
  detail: string;
  state: CheckState;
};

export type CandidateChange = {
  id: string;
  path: string;
  agent: string;
  add: number;
  del: number;
  state: FileState;
  summary: string;
};

export type IntegrationWarning = {
  id: string;
  title: string;
  detail: string;
  severity: "conflict" | "warning";
  agents: string[];
  conflictId?: string;
};

export type DiffLine = { type: "context" | "add" | "remove"; text: string };

export type ConflictSide = {
  agentId: string;
  agentName: string;
  lines: string[];
};

export type ConflictStep = { title: string; detail: string };

export type Conflict = {
  id: string;
  path: string;
  ours: ConflictSide;
  theirs: ConflictSide;
  aiSteps: ConflictStep[];
  resolutionLines: string[];
};

export type ChatRole = "prompt" | "response";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  author: string;
  authorTone?: string;
  text: string;
  time: string;
};

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
    status: "writing",
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
    kind: "worker",
  },
  {
    id: "nova",
    name: "Nova",
    role: "Frontend worker",
    task: "Agent activity cards",
    owner: "Ryan",
    color: "#b8862a",
    status: "needs-input",
    progress: 58,
    detail: "Wiring live status transitions to the session view",
    alert: "Should a blocked card keep its progress bar, or swap it for the blocker reason?",
    files: ["app/session/AgentCard.tsx", "app/session/activity.css"],
    branch: "of/nova-agent-cards",
    time: "8m",
    model: "Frontier",
    autonomy: "autopilot",
    baseBranch: sessionFacts.branch,
    checks: ["types", "lint"],
    reviewRequired: true,
    kind: "worker",
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
    alert: "Atlas has not landed the event payload shape yet, so the reducer tests cannot be written.",
    files: ["tests/session-reducer.test.ts"],
    branch: "of/sentry-reducer-tests",
    time: "6m",
    model: "Swift",
    autonomy: "autopilot",
    baseBranch: sessionFacts.branch,
    checks: ["types", "unit", "lint"],
    reviewRequired: false,
    kind: "worker",
  },
  {
    id: "proof",
    name: "Proof",
    role: "Reviewer",
    task: "Integrated change review",
    owner: "Ali",
    color: "#4e6f8a",
    status: "idle",
    progress: 41,
    detail: "Checking task boundaries and combined type safety",
    alert: "Nothing left to review until Atlas and Nova push their next commits.",
    files: ["server/session/reducer.ts", "app/session/AgentCard.tsx"],
    branch: "of/proof-integrated-review",
    time: "4m",
    model: "Frontier",
    autonomy: "suggest",
    baseBranch: sessionFacts.branch,
    checks: ["types"],
    reviewRequired: false,
    kind: "worker",
  },
  {
    id: "openmind",
    name: "OpenMind",
    role: "Orchestrator",
    task: "Sequencing session work",
    owner: "System",
    color: "#4c6d88",
    status: "writing",
    progress: 100,
    detail: "Sequencing Atlas → Nova → Sentry integration and watching for scope conflicts.",
    files: [],
    branch: sessionFacts.branch,
    time: "24m",
    model: "Frontier XL",
    autonomy: "autopilot",
    baseBranch: sessionFacts.branch,
    checks: [],
    reviewRequired: false,
    kind: "orchestrator",
  },
  {
    id: "q",
    name: "Q",
    role: "Q&A service",
    task: "Answering questions from the team",
    owner: "System",
    color: "#8b6bb1",
    status: "writing",
    progress: 100,
    detail: "Waiting for questions.",
    files: [],
    branch: sessionFacts.branch,
    time: "24m",
    model: "Swift",
    autonomy: "autopilot",
    baseBranch: sessionFacts.branch,
    checks: [],
    reviewRequired: false,
    kind: "qa",
  },
];

export const initialAssignments: Assignment[] = [
  {
    id: "matt",
    name: "Matt",
    initials: "M",
    tone: "matt",
    task: "Define the session event protocol and reconnect replay contract.",
    state: "Active",
    stateTone: "running",
  },
  {
    id: "ryan",
    name: "Ryan",
    initials: "R",
    tone: "ryan",
    task: "Build agent activity cards and wire live status transitions.",
    state: "Active",
    stateTone: "running",
  },
  {
    id: "ali",
    name: "Ali",
    initials: "A",
    tone: "ali",
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

export const initialTeamChat: TeamChatMessage[] = [
  {
    id: "tc-1",
    authorId: "matt",
    authorName: "Matt",
    authorTone: "matt",
    text: "Kicking off the presence work — Atlas is on the event protocol, Nova's on the activity cards.",
    time: "24m ago",
  },
  {
    id: "tc-2",
    authorId: "ryan",
    authorName: "Ryan",
    authorTone: "ryan",
    text: "Sounds good. I'll keep Nova scoped to AgentCard.tsx and activity.css only.",
    time: "22m ago",
  },
  {
    id: "tc-3",
    authorId: "ali",
    authorName: "Ali",
    authorTone: "ali",
    text: "Joining now — I'll have Proof review once Atlas and Nova both have something to look at.",
    time: "18m ago",
  },
  {
    id: "tc-4",
    authorId: "matt",
    authorName: "Matt",
    authorTone: "matt",
    text: "Heads up, Atlas and Proof both touched reducer.ts. Flagging it as a conflict on the floor.",
    time: "9m ago",
  },
  {
    id: "tc-5",
    authorId: "ali",
    authorName: "Ali",
    authorTone: "ali",
    text: "Saw it — Proof's pass is read-only, so keeping Atlas as owner should resolve it cleanly.",
    time: "8m ago",
  },
  {
    id: "tc-6",
    authorId: "ryan",
    authorName: "Ryan",
    authorTone: "ryan",
    text: "Nova's almost done with the blocked-state styling. Sentry can pick up reducer fixtures right after.",
    time: "4m ago",
  },
  {
    id: "tc-7",
    authorId: "matt",
    authorName: "Matt",
    authorTone: "matt",
    text: "Nice. Once checks are green I'll open the candidate branch for review.",
    time: "2m ago",
  },
];

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

export const candidateBranch = {
  name: "openfloor/session-presence",
  sha: "a3f8c21",
  base: "main",
  message: "Normalize session events and agent activity cards",
};

export const candidateChanges: CandidateChange[] = [
  {
    id: "schema",
    path: "server/events/schema.ts",
    agent: "Atlas",
    add: 84,
    del: 6,
    state: "modified",
    summary: "Adds reconnect replay envelope fields and sequence acknowledgements.",
  },
  {
    id: "reducer",
    path: "server/session/reducer.ts",
    agent: "Atlas · Proof",
    add: 126,
    del: 18,
    state: "attention",
    summary: "Merges Atlas lifecycle events with Proof's read-only status naming pass.",
  },
  {
    id: "cards",
    path: "app/session/AgentCard.tsx",
    agent: "Nova · Proof",
    add: 192,
    del: 12,
    state: "modified",
    summary: "Wires live agent status transitions into the session activity cards.",
  },
  {
    id: "activity-css",
    path: "app/session/activity.css",
    agent: "Nova",
    add: 77,
    del: 4,
    state: "modified",
    summary: "Adds progress and blocked-state styling for the activity floor.",
  },
  {
    id: "tests",
    path: "tests/session-reducer.test.ts",
    agent: "Sentry",
    add: 63,
    del: 0,
    state: "pending",
    summary: "Covers replay ordering once the event payload shape lands.",
  },
];

export const reviewChecks: ReviewCheck[] = [
  { id: "types", name: "Type check", detail: "Passed · 32s", state: "passed" },
  { id: "unit", name: "Unit tests", detail: "48 passed · 1m 14s", state: "passed" },
  { id: "lint", name: "Lint", detail: "No warnings · 18s", state: "passed" },
  { id: "build", name: "Build", detail: "Passed · 51s", state: "passed" },
  { id: "integration", name: "Integration suite", detail: "Waiting on OF-19", state: "waiting" },
];

export const integrationWarnings: IntegrationWarning[] = [
  {
    id: "scope-overlap",
    title: "Overlapping write on server/session/reducer.ts",
    detail: "Atlas and Proof both touched this file. Proof's pass is marked read-only pending resolution.",
    severity: "conflict",
    agents: ["Atlas", "Proof"],
    conflictId: "scope-overlap",
  },
  {
    id: "pending-tests",
    title: "Sentry tests are still pending",
    detail: "Coverage for reconnect replay will land after Atlas finalizes the payload shape.",
    severity: "warning",
    agents: ["Sentry"],
  },
];

export const conflicts: Conflict[] = [
  {
    id: "scope-overlap",
    path: "server/session/reducer.ts",
    ours: {
      agentId: "atlas",
      agentName: "Atlas",
      lines: [
        'case "agent.status_changed": {',
        "  return updateAgent(state, agent.id, {",
        "    status: event.payload.status,",
        "    currentStep: event.payload.currentStep,",
        "    updatedAt: event.occurredAt,",
        "  });",
        "}",
      ],
    },
    theirs: {
      agentId: "proof",
      agentName: "Proof",
      lines: [
        'case "agent.status_changed": {',
        "  return updateAgent(state, agent.id, {",
        "    ...event.payload,",
        "    status: normalizeStatus(event.payload.status),",
        "  });",
        "}",
      ],
    },
    aiSteps: [
      {
        title: "Atlas restructured the update",
        detail:
          "Atlas expanded the single event.payload spread into explicit status, currentStep, and updatedAt fields so the reducer only writes fields it knows about.",
      },
      {
        title: "Proof normalized the status value",
        detail:
          "Proof's read-only pass wraps the incoming status through normalizeStatus() so card badges and agent.status agree on casing, but kept the original spread instead of Atlas's explicit fields.",
      },
      {
        title: "Combine both intents",
        detail:
          "Keep Atlas's explicit field list to avoid writing unexpected payload keys, and apply Proof's normalizeStatus() to the status field so naming stays consistent.",
      },
      {
        title: "Suggested resolution",
        detail: "Apply the merged version below, then confirm Sentry's reducer suite covers a case-mismatched status transition.",
      },
    ],
    resolutionLines: [
      'case "agent.status_changed": {',
      "  return updateAgent(state, agent.id, {",
      "    status: normalizeStatus(event.payload.status),",
      "    currentStep: event.payload.currentStep,",
      "    updatedAt: event.occurredAt,",
      "  });",
      "}",
    ],
  },
];

export const diffPreview: { path: string; agent: string; lines: DiffLine[] } = {
  path: "server/session/reducer.ts",
  agent: "Atlas · Proof",
  lines: [
    { type: "context", text: 'case "agent.status_changed": {' },
    { type: "remove", text: "  return updateAgent(state, agent.id, event.payload);" },
    { type: "add", text: "  return updateAgent(state, agent.id, {" },
    { type: "add", text: "    status: event.payload.status," },
    { type: "add", text: "    currentStep: event.payload.currentStep," },
    { type: "add", text: "    updatedAt: event.occurredAt," },
    { type: "add", text: "  });" },
    { type: "context", text: "}" },
  ],
};

export const initialQueue: QueueItem[] = [
  {
    id: "q-1",
    prompt: "Have Atlas document the reconnect replay contract before Sentry extends coverage.",
    author: "Matt",
    authorTone: "matt",
    agentId: "atlas",
    agentName: "Atlas",
    agentColor: "#c9552f",
    position: 1,
    status: "queued",
    queuedAt: "6m ago",
  },
  {
    id: "q-2",
    prompt: "Nova should add an empty state for agents with no claimed write scope yet.",
    author: "You",
    authorTone: "you",
    agentId: "nova",
    agentName: "Nova",
    agentColor: "#b8862a",
    position: 2,
    status: "queued",
    queuedAt: "4m ago",
  },
  {
    id: "q-3",
    prompt: "Sentry: wait for Atlas payload shape, then fill the reducer replay fixtures.",
    author: "Ryan",
    authorTone: "ryan",
    agentId: "sentry",
    agentName: "Sentry",
    agentColor: "#4a7d68",
    position: 3,
    status: "waiting",
    queuedAt: "3m ago",
  },
  {
    id: "q-4",
    prompt: "Proof, review naming consistency between agent.status and card badges once Nova lands.",
    author: "Ali",
    authorTone: "ali",
    agentId: "proof",
    agentName: "Proof",
    agentColor: "#4e6f8a",
    position: 4,
    status: "queued",
    queuedAt: "2m ago",
  },
  {
    id: "q-5",
    prompt:
      "After the event schema lands, ask Atlas to add a short note on how reconnect clients should ack the last sequence without replaying completed agent steps.",
    author: "You",
    authorTone: "you",
    agentId: "atlas",
    agentName: "Atlas",
    agentColor: "#c9552f",
    position: 5,
    status: "queued",
    queuedAt: "1m ago",
  },
];

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

/* Every file an agent moves between while it works, for the codebase-mode "live edit" animation. */
export const agentFileLibrary: Record<string, { path: string; lines: string[] }[]> = {
  atlas: [
    codeByAgent.atlas,
    {
      path: "server/session/reducer.ts",
      lines: conflicts.find((conflict) => conflict.id === "scope-overlap")!.ours.lines,
    },
  ],
  nova: [
    codeByAgent.nova,
    {
      path: "app/session/activity.css",
      lines: [
        '.agent-card[data-status="blocked"] {',
        "  border-left-color: var(--status-blocked);",
        "}",
        "",
        ".agent-card .progress-track i {",
        "  transition: width 220ms ease;",
        "}",
        "",
        '.agent-card[data-status="writing"] .status-dot {',
        "  animation: pulse 1.6s ease-in-out infinite;",
        "}",
      ],
    },
  ],
  sentry: [codeByAgent.sentry],
  proof: [
    {
      path: "server/session/reducer.ts",
      lines: conflicts.find((conflict) => conflict.id === "scope-overlap")!.theirs.lines,
    },
    codeByAgent.nova,
  ],
};

export function agentCodeFiles(agent: Agent): { path: string; lines: string[] }[] {
  return agentFileLibrary[agent.id] ?? [codeByAgent[agent.id] ?? codeByAgent.atlas];
}

/* Prompts sent to each agent and the responses it gave, oldest first. */
export const agentChatHistory: Record<string, ChatMessage[]> = {
  atlas: [
    {
      id: "atlas-1",
      role: "prompt",
      author: "Matt",
      authorTone: "matt",
      text: "Define the session event protocol and reconnect replay contract.",
      time: "12m ago",
    },
    {
      id: "atlas-2",
      role: "response",
      author: "Atlas",
      text: "Reading the task contract and claiming server/events/schema.ts and server/session/reducer.ts.",
      time: "11m ago",
    },
    {
      id: "atlas-3",
      role: "prompt",
      author: "Matt",
      authorTone: "matt",
      text: "Atlas, keep the event envelope backwards compatible with reconnect replay.",
      time: "3m ago",
    },
    {
      id: "atlas-4",
      role: "response",
      author: "Atlas",
      text: "Added causationId and sequence fields without breaking the existing payload shape. Running type and unit checks now.",
      time: "1m ago",
    },
    {
      id: "atlas-5",
      role: "prompt",
      author: "You",
      authorTone: "you",
      text: "After the event schema lands, add a short note on how reconnect clients should ack the last sequence without replaying completed steps.",
      time: "just now",
    },
  ],
  nova: [
    {
      id: "nova-1",
      role: "prompt",
      author: "Ryan",
      authorTone: "ryan",
      text: "Build agent activity cards and wire live status transitions.",
      time: "8m ago",
    },
    {
      id: "nova-2",
      role: "response",
      author: "Nova",
      text: "Mapping the task to the session view before editing app/session/AgentCard.tsx.",
      time: "7m ago",
    },
    {
      id: "nova-3",
      role: "prompt",
      author: "Ryan",
      authorTone: "ryan",
      text: "Nova, add the blocked state before you prepare the frontend patch.",
      time: "4m ago",
    },
    {
      id: "nova-4",
      role: "response",
      author: "Nova",
      text: "Wired live status transitions and added progress/blocked-state styling to activity.css.",
      time: "2m ago",
    },
    {
      id: "nova-5",
      role: "prompt",
      author: "You",
      authorTone: "you",
      text: "Nova should add an empty state for agents with no claimed write scope yet.",
      time: "just now",
    },
  ],
  sentry: [
    {
      id: "sentry-1",
      role: "prompt",
      author: "Matt",
      authorTone: "matt",
      text: "Cover the event reducer replay ordering once Atlas's payload shape lands.",
      time: "6m ago",
    },
    {
      id: "sentry-2",
      role: "response",
      author: "Sentry",
      text: "Reading existing coverage to find the gaps worth closing. Blocked on Atlas's payload shape for now.",
      time: "5m ago",
    },
    {
      id: "sentry-3",
      role: "prompt",
      author: "Ryan",
      authorTone: "ryan",
      text: "Sentry: wait for Atlas payload shape, then fill the reducer replay fixtures.",
      time: "3m ago",
    },
  ],
  proof: [
    {
      id: "proof-1",
      role: "prompt",
      author: "Ali",
      authorTone: "ali",
      text: "Review integrated changes and resolve status naming inconsistencies.",
      time: "4m ago",
    },
    {
      id: "proof-2",
      role: "response",
      author: "Proof",
      text: "Checking task boundaries and combined type safety between Atlas's reducer and Nova's cards.",
      time: "3m ago",
    },
    {
      id: "proof-3",
      role: "prompt",
      author: "Ali",
      authorTone: "ali",
      text: "Proof, review naming consistency between agent.status and card badges once Nova lands.",
      time: "2m ago",
    },
  ],
};

export function agentChatMessages(agent: Agent): ChatMessage[] {
  return agentChatHistory[agent.id] ?? [];
}

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
    status: draft.roleId === "reviewer" ? "reviewing" : "writing",
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
    kind: "worker",
  };
}

export function autonomyLabel(autonomy: AgentAutonomy): string {
  return autonomyOptions.find((option) => option.value === autonomy)?.label ?? autonomy;
}

/* Returns a `.state-tag[data-tone]` name, not a status — the two vocabularies differ. */
export function statusTone(status: AgentStatus): string {
  if (status === "blocked") return "blocked";
  if (status === "needs-input") return "attention";
  if (status === "idle" || status === "complete") return "waiting";
  if (status === "reviewing") return "review";
  return "running";
}

export function statusLabel(status: AgentStatus): string {
  return status === "needs-input" ? "needs input" : status;
}

/* The callout shown on a focused agent. Null for states that need nothing from a human. */
export function statusAlert(agent: Agent): { title: string; body: string; action: string; notice: string } | null {
  if (agent.status === "needs-input") {
    return {
      title: "Needs your input",
      body: agent.alert ?? `${agent.name} is waiting on an answer before it can keep going.`,
      action: "Answer",
      notice: `${agent.name} was told you are drafting an answer`,
    };
  }
  if (agent.status === "blocked") {
    return {
      title: "Blocked",
      body: agent.alert ?? agent.detail,
      action: "Nudge owner",
      notice: `${agent.owner} was asked to unblock ${agent.name}`,
    };
  }
  if (agent.status === "idle") {
    return {
      title: "Idle",
      body: agent.alert ?? `${agent.name} has no work queued right now.`,
      action: "Resume",
      notice: `${agent.name} was asked to pick up new work`,
    };
  }
  return null;
}

export function agentKindLabel(agent: Agent): string {
  if (agent.kind === "orchestrator") return "Orchestrator";
  if (agent.kind === "qa") return agent.parentId ? "Q&A · sub-agent" : "Q&A";
  return "Worker";
}

/* Agents a person can address directly, either by @mention or from the composer dropdown.
   Excludes OpenMind (the implicit auto-router) and Q's ephemeral sub-agents. */
export function routableAgents(agents: Agent[]): Agent[] {
  return agents.filter((agent) => agent.kind !== "orchestrator" && !agent.parentId);
}

/* Matches one "@Name" token. Shared by routing and by the composer's highlight/autocomplete. */
export const MENTION_TOKEN = /@([A-Za-z][\w-]*)/;

/* Finds the first "@Name" in the text that matches an agent's name, case-insensitively. */
export function resolveAgentMention(text: string, agents: Agent[]): Agent | null {
  const match = text.match(MENTION_TOKEN);
  if (!match) return null;

  const mentioned = match[1].toLowerCase();
  return routableAgents(agents).find((agent) => agent.name.toLowerCase() === mentioned) ?? null;
}

/* OpenMind's default pick when nobody names an agent: whoever's blocked, else whoever has the least progress. */
export function pickAgentForOpenMind(agents: Agent[]): Agent {
  const workers = agents.filter((agent) => agent.kind === "worker");
  const blocked = workers.find((agent) => agent.status === "blocked");
  if (blocked) return blocked;

  return workers.reduce((leastDone, agent) => (agent.progress < leastDone.progress ? agent : leastDone), workers[0]);
}

/* A short-lived agent Q spins up to answer a question while its primary thread is busy. */
export function spawnQSubAgent(question: string, owner: string, sequence: number): Agent {
  const shortQuestion = question.length > 60 ? `${question.slice(0, 57)}…` : question;

  return {
    id: `q-sub-${sequence}`,
    name: `Q · sub-${sequence}`,
    role: "Q&A sub-agent",
    task: shortQuestion,
    owner,
    color: "#8b6bb1",
    status: "writing",
    progress: 50,
    detail: `Answering: "${shortQuestion}"`,
    files: [],
    branch: sessionFacts.branch,
    time: "now",
    model: "Swift",
    autonomy: "autopilot",
    baseBranch: sessionFacts.branch,
    checks: [],
    reviewRequired: false,
    kind: "qa",
    parentId: "q",
  };
}

/* Scopes the candidate-branch review data down to one agent's own contribution. */
export function agentReviewChanges(agent: Agent): CandidateChange[] {
  return candidateChanges.filter((change) => agent.files.includes(change.path));
}

export function agentReviewChecks(agent: Agent): ReviewCheck[] {
  return reviewChecks.filter((check) => agent.checks.includes(check.id));
}

export function agentReviewWarnings(agent: Agent): IntegrationWarning[] {
  return integrationWarnings.filter((warning) => warning.agents.includes(agent.name));
}

export function agentDiffLines(agent: Agent): { path: string; lines: DiffLine[] } | null {
  const code = codeByAgent[agent.id];
  if (!code) return null;

  return { path: code.path, lines: code.lines.map((text) => ({ type: "add", text })) };
}

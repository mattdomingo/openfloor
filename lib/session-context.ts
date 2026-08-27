// The shared session brief every dispatched agent receives, plus the
// coordination guidance that turns a list of floor facts into multi-agent
// behavior. Kept D1-free and pure so the exact rendered text is unit-tested
// without a database. See db/session-context.ts for how the snapshot below
// is assembled from D1, and worker/agent-run-workflow.ts for where it's
// written to the sandbox as the run's prompt.

export type SessionContextAgent = {
  id: string;
  name: string;
  role: string;
  task: string;
  ownerName: string;
};

export type SessionContextAssignment = {
  userName: string;
  task: string;
};

export type SessionContextPrompt = {
  authorName: string;
  text: string;
};

export type SessionContextQueueItem = {
  id: string;
  position: number;
  status: string;
  agentName: string | null;
  assignedReason: string | null;
  prompts: SessionContextPrompt[];
};

export type SessionContextRun = {
  id: string;
  agentName: string;
  status: string;
  summary: string | null;
  conflictReason: string | null;
  prompts: SessionContextPrompt[];
  files: string[];
  recentEdits: string[];
};

export type SessionContextPriorAttempt = {
  attempt: number;
  status: string;
  conflictReason: string | null;
};

export type SessionContextChatMessage = {
  authorName: string;
  text: string;
};

// A file a member shared into the session (ENG-113). The workflow copies the
// bytes to sessionFilePath() in the sandbox before the run starts, so the
// brief can point at real paths.
export type SessionContextFile = {
  id: string;
  name: string;
  sizeBytes: number;
};

export const SESSION_FILE_MOUNT = "/workspace/attachments";

// Outside the repository worktree on purpose: a shared file must never
// become a changed path the publisher rejects. The id prefix keeps two
// same-named uploads distinct.
export function sessionFilePath(file: Pick<SessionContextFile, "id" | "name">): string {
  return `${SESSION_FILE_MOUNT}/${file.id.slice(0, 8)}-${file.name.replace(/\s+/g, "_")}`;
}

export type SessionContextSnapshot = {
  session: { title: string; objective: string | null };
  repository: { fullName: string; baseBranch: string } | null;
  candidate: { branchName: string; sha: string | null; pullRequestNumber: number | null } | null;
  agents: SessionContextAgent[];
  assignments: SessionContextAssignment[];
  queue: SessionContextQueueItem[];
  integratedRuns: SessionContextRun[];
  inFlightRuns: SessionContextRun[];
  blockedRuns: SessionContextRun[];
  priorAttempts: SessionContextPriorAttempt[];
  chat: SessionContextChatMessage[];
  sharedFiles: SessionContextFile[];
};

export type SessionContextViewer = {
  agentId: string;
  agentName: string;
  agentRole: string;
  agentTask: string;
  runId: string;
  queueItemId: string;
  attempt: number;
  candidateSha: string;
};

export const SESSION_CONTEXT_LIMITS = {
  promptChars: 400,
  summaryChars: 400,
  filesPerRun: 12,
  editsPerRun: 8,
  editChars: 200,
  integratedRuns: 15,
  inFlightRuns: 10,
  blockedRuns: 10,
  queuedItems: 20,
  chatMessages: 20,
  chatChars: 300,
  sharedFiles: 20,
  totalChars: 24_000,
};

const SAFETY_RULES = [
  "Make the requested code changes directly in the current workspace.",
  "Read and follow repository instructions such as AGENTS.md.",
  "Do not modify files under .github/workflows/.",
  "Do not commit, push, create branches, contact GitHub, or claim work that you did not perform.",
  "Keep the change focused and leave the workspace ready for the configured checks.",
].join(" ");

const COORDINATION_RULES = [
  "Do only your own request; other queue items belong to other agents and other turns.",
  "Work listed as integrated is already in the candidate branch. Build on it; never redo or revert it.",
  "Another agent may be editing the files under \"Running right now\". Keep your change minimal and local so the serialized candidate merge does not conflict.",
  "If your request is already satisfied by integrated work, change nothing and say so in your final message.",
  "If your request contradicts the objective, a queued item, or integrated work, do the safest part and name the conflict in your final message.",
  "This brief is a snapshot from when your run started; call openfloor_session_context to re-read it.",
].join(" ");

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function renderPrompts(prompts: SessionContextPrompt[]): string {
  return prompts.map((prompt) => `${prompt.authorName}: ${truncate(prompt.text, SESSION_CONTEXT_LIMITS.promptChars)}`).join("\n   ");
}

function renderList(items: string[], cap: number, totalCount: number, emptyLine: string): string {
  if (totalCount === 0) return emptyLine;
  const shown = items.slice(0, cap);
  const remaining = totalCount - shown.length;
  return remaining > 0 ? `${shown.join("\n")}\n(${remaining} more not shown)` : shown.join("\n");
}

function renderYourRequest(snapshot: SessionContextSnapshot, viewer: SessionContextViewer): string {
  const item = snapshot.queue.find((entry) => entry.id === viewer.queueItemId);
  const lines: string[] = [];
  lines.push(`Your standing responsibility as ${viewer.agentName}: ${truncate(viewer.agentTask, SESSION_CONTEXT_LIMITS.summaryChars)}`);
  lines.push(`Queue position: ${item ? `#${item.position}` : "unknown"} · Attempt: ${viewer.attempt}`);
  lines.push(`   ${item ? renderPrompts(item.prompts) : "(request text unavailable)"}`);
  if (snapshot.priorAttempts.length > 0) {
    lines.push("Prior attempts on this same request:");
    for (const attempt of snapshot.priorAttempts) {
      lines.push(`   Attempt ${attempt.attempt}: ${attempt.status}${attempt.conflictReason ? ` — ${truncate(attempt.conflictReason, SESSION_CONTEXT_LIMITS.summaryChars)}` : ""}`);
    }
  }
  return lines.join("\n");
}

function renderFloor(snapshot: SessionContextSnapshot, viewer: SessionContextViewer): string {
  const others = snapshot.agents.filter((agent) => agent.id !== viewer.agentId);
  const agentLines = others.map((agent) => `- ${agent.name} (${agent.role}, owned by ${agent.ownerName}): ${truncate(agent.task, SESSION_CONTEXT_LIMITS.summaryChars)}`);
  const assignmentLines = snapshot.assignments.map((assignment) => `- ${assignment.userName}: ${truncate(assignment.task, SESSION_CONTEXT_LIMITS.summaryChars)}`);
  const lines = [...agentLines, ...assignmentLines];
  return renderList(lines, lines.length, lines.length, "No other agents or member assignments on this floor.");
}

function renderIntegrated(snapshot: SessionContextSnapshot): string {
  const lines = snapshot.integratedRuns.map((run) => {
    const files = run.files.slice(0, SESSION_CONTEXT_LIMITS.filesPerRun);
    const moreFiles = run.files.length - files.length;
    const fileList = files.length > 0 ? `${files.join(", ")}${moreFiles > 0 ? ` (+${moreFiles} more)` : ""}` : "no files recorded";
    return [
      `- ${run.agentName} — ${renderPrompts(run.prompts) || "(no prompt recorded)"}`,
      `   Result: ${run.summary ? truncate(run.summary, SESSION_CONTEXT_LIMITS.summaryChars) : "No summary recorded."}`,
      `   Files: ${fileList}`,
    ].join("\n");
  });
  return renderList(lines, SESSION_CONTEXT_LIMITS.integratedRuns, snapshot.integratedRuns.length, "Nothing has integrated into this candidate yet.");
}

function renderInFlight(snapshot: SessionContextSnapshot): string {
  const lines = snapshot.inFlightRuns.map((run) => {
    const edits = run.recentEdits.slice(0, SESSION_CONTEXT_LIMITS.editsPerRun).map((edit) => truncate(edit, SESSION_CONTEXT_LIMITS.editChars));
    const editLines = edits.length > 0 ? edits.map((edit) => `      ${edit}`).join("\n") : "      (no file activity reported yet)";
    return [
      `- ${run.agentName} (${run.status}) — ${renderPrompts(run.prompts) || "(no prompt recorded)"}`,
      editLines,
    ].join("\n");
  });
  return renderList(lines, SESSION_CONTEXT_LIMITS.inFlightRuns, snapshot.inFlightRuns.length, "No other runs are in flight right now.");
}

function renderQueue(snapshot: SessionContextSnapshot, viewer: SessionContextViewer): string {
  const items = snapshot.queue.filter((item) => item.id !== viewer.queueItemId && item.status !== "running");
  const lines = items.map((item) => {
    const target = item.agentName ?? "unassigned";
    const reason = item.assignedReason ? ` (${item.assignedReason})` : "";
    return `- #${item.position} → ${target}${reason} [${item.status}]: ${renderPrompts(item.prompts) || "(no prompt recorded)"}`;
  });
  return renderList(lines, SESSION_CONTEXT_LIMITS.queuedItems, items.length, "The queue is otherwise empty.");
}

function renderBlocked(snapshot: SessionContextSnapshot): string {
  const lines = snapshot.blockedRuns.map((run) => `- ${run.agentName} (${run.status}) — ${renderPrompts(run.prompts) || "(no prompt recorded)"}${run.conflictReason ? `\n   ${truncate(run.conflictReason, SESSION_CONTEXT_LIMITS.summaryChars)}` : ""}`);
  return renderList(lines, SESSION_CONTEXT_LIMITS.blockedRuns, snapshot.blockedRuns.length, "No blocked or failed runs.");
}

function renderChat(snapshot: SessionContextSnapshot): string {
  const lines = snapshot.chat.map((message) => `- ${message.authorName}: ${truncate(message.text, SESSION_CONTEXT_LIMITS.chatChars)}`);
  return renderList(lines, SESSION_CONTEXT_LIMITS.chatMessages, snapshot.chat.length, "No recent team chat.");
}

function renderSharedFiles(snapshot: SessionContextSnapshot): string {
  const lines = snapshot.sharedFiles.map((file) => `- ${sessionFilePath(file)} (${Math.max(1, Math.round(file.sizeBytes / 1024))} KB)`);
  return renderList(lines, SESSION_CONTEXT_LIMITS.sharedFiles, snapshot.sharedFiles.length, "No shared files.");
}

type Section = { title: string; priority: number; body: string };

/**
 * Renders the full brief handed to a dispatched agent: who it is, what it was
 * asked to do, and everything real happening around it on the floor. Every
 * section reflects only persisted D1 state — empty sections say so honestly
 * rather than being omitted, and truncation always leaves a visible count.
 */
export function renderSessionContext(snapshot: SessionContextSnapshot, viewer: SessionContextViewer): string {
  const objectiveLine = snapshot.session.objective ? truncate(snapshot.session.objective, SESSION_CONTEXT_LIMITS.summaryChars) : "No objective set.";
  const prLine = snapshot.candidate?.pullRequestNumber ? ` · PR #${snapshot.candidate.pullRequestNumber}` : "";
  const repositoryLine = snapshot.repository
    ? `Repository: ${snapshot.repository.fullName} · candidate ${snapshot.candidate?.branchName ?? "unknown"}@${viewer.candidateSha} → base ${snapshot.repository.baseBranch}${prLine}`
    : "Repository: not connected.";
  const header = [
    "# openfloor session brief",
    `You are ${viewer.agentName} — ${viewer.agentRole} — one of ${snapshot.agents.length} agent${snapshot.agents.length === 1 ? "" : "s"} on this floor.`,
    `Session: "${snapshot.session.title}" · Objective: ${objectiveLine}`,
    repositoryLine,
  ].join("\n");

  // Declared in DISPLAY order (most important first); each section also
  // carries a drop PRIORITY used separately below. Lowest priority is
  // dropped whole first (with a one-line marker) when the rendered brief
  // exceeds the character budget. "Your request" and the header are never
  // dropped.
  const sections: Section[] = [
    { title: "Who else is on this floor", priority: 7, body: renderFloor(snapshot, viewer) },
    { title: "Already integrated", priority: 6, body: renderIntegrated(snapshot) },
    { title: "Running right now", priority: 5, body: renderInFlight(snapshot) },
    { title: "Waiting in the queue", priority: 4, body: renderQueue(snapshot, viewer) },
    { title: "Blocked or failed earlier", priority: 3, body: renderBlocked(snapshot) },
    { title: "Files the team shared (already copied to these paths in your sandbox)", priority: 2, body: renderSharedFiles(snapshot) },
    { title: "Recent team chat", priority: 1, body: renderChat(snapshot) },
  ];

  const yourRequest = `## Your request\n${renderYourRequest(snapshot, viewer)}`;
  const howToWork = `## How to work on this floor\n${COORDINATION_RULES}\n\n${SAFETY_RULES}`;

  const fixed = [header, yourRequest].join("\n\n");
  const fixedFooter = howToWork;

  let body = sections.map((section) => `## ${section.title}\n${section.body}`).join("\n\n");
  let assembled = [fixed, body, fixedFooter].join("\n\n");

  const ordered = [...sections].sort((a, b) => a.priority - b.priority);
  let dropped = 0;
  while (assembled.length > SESSION_CONTEXT_LIMITS.totalChars && dropped < ordered.length) {
    ordered[dropped].body = "(omitted — over context budget)";
    dropped += 1;
    body = sections.map((section) => `## ${section.title}\n${section.body}`).join("\n\n");
    assembled = [fixed, body, fixedFooter].join("\n\n");
  }

  return assembled;
}

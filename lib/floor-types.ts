export type FloorDomain = "agents" | "assignments" | "messages" | "queue" | "review";

export type FloorParticipant = {
  id: string;
  name: string;
  initials: string;
  tone: string;
  role: "owner" | "member";
  online: boolean;
  isCurrentUser: boolean;
};

export type FloorAgentState = "created";

export type FloorAgent = {
  id: string;
  name: string;
  role: string;
  task: string;
  ownerUserId: string;
  ownerName: string;
  createdByUserId: string;
  state: FloorAgentState;
  createdAt: number;
  updatedAt: number;
};

export type FloorAssignment = {
  userId: string;
  userName: string;
  task: string | null;
  updatedByUserId: string | null;
  updatedAt: number | null;
};

export type FloorMessage = {
  id: string;
  authorUserId: string;
  authorName: string;
  recipientUserId: string | null;
  text: string;
  createdAt: number;
};

export type FloorQueuePrompt = {
  id: string;
  authorUserId: string;
  authorName: string;
  text: string;
  createdAt: number;
};

export type FloorQueueItem = {
  id: string;
  agentId: string | null;
  agentName: string | null;
  position: number;
  status: "queued";
  prompts: FloorQueuePrompt[];
  createdAt: number;
  updatedAt: number;
};

export type FloorReviewSnapshot = {
  id: string;
  status: "awaiting" | "changes-requested" | "approved";
  branch: string;
  baseBranch: string;
  commitSha: string | null;
  files: Array<{
    id: string;
    path: string;
    agentId: string | null;
    agentName: string | null;
    additions: number;
    deletions: number;
    summary: string | null;
    diff: Array<{ type: "context" | "add" | "remove"; text: string }>;
  }>;
  checks: Array<{ id: string; name: string; detail: string | null; state: "passed" | "waiting" | "failed" }>;
  warnings: Array<{ id: string; title: string; detail: string; severity: "conflict" | "warning" }>;
  updatedAt: number;
};

export type FloorSnapshot = {
  revision: number;
  agents: FloorAgent[];
  assignments: FloorAssignment[];
  messages: FloorMessage[];
  queue: FloorQueueItem[];
  review: FloorReviewSnapshot | null;
};

export type CreateFloorAgentInput = {
  name: string;
  role: string;
  task: string;
  ownerUserId: string;
};

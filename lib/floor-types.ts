import type {
  Agent,
  AgentDraft,
  Assignment,
  QueueItem,
  TeamChatMessage,
} from "@/components/session/data";

export type FloorParticipant = {
  id: string;
  name: string;
  initials: string;
  tone: string;
  role: "owner" | "member";
  online: boolean;
  isCurrentUser: boolean;
};

export type FloorSnapshot = {
  participants: FloorParticipant[];
  agents: Agent[];
  assignments: Assignment[];
  queue: QueueItem[];
  messages: TeamChatMessage[];
};

// UI components consume this contract rather than fixture arrays. A future
// persistent implementation can replace the prototype hook without changing
// panel component props or workspace behavior.
export type FloorDataSource = {
  kind: "prototype";
  snapshot: FloorSnapshot;
  addAgent(draft: AgentDraft): Agent;
  updateAgents(update: (agents: Agent[]) => Agent[]): void;
  updateAssignment(id: string, task: string): void;
  replaceQueue(items: QueueItem[]): void;
  sendMessage(message: TeamChatMessage): void;
};

export type { Agent, AgentDraft, Assignment, QueueItem, TeamChatMessage };

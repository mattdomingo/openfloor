import type { FloorAgent, FloorMessage } from "./floor-types";
import type { PresenceEvent } from "./session-types";

// Owner-facing nudge: sessions.updated_at advances on every floor mutation
// (bumpFloorRevision touches it alongside floor_revision), so it can't stand
// in for "when the objective was last edited" — objectiveUpdatedAt is the
// dedicated column set only by updateSessionObjective. DMs are excluded; the
// nudge reflects team-visible drift, not private conversation.
export const OBJECTIVE_NUDGE_THRESHOLD = 10;

export function countMessagesSinceObjective(messages: FloorMessage[], objectiveUpdatedAt: number): number {
  return messages.filter((message) => message.recipientUserId === null && message.createdAt > objectiveUpdatedAt).length;
}

export function latestTeamMessageAt(messages: FloorMessage[]): number {
  return messages.reduce((max, message) => (message.recipientUserId === null ? Math.max(max, message.createdAt) : max), 0);
}

export function countUnreadTeamMessages(messages: FloorMessage[], lastReadAt: number): number {
  return messages.filter((message) => message.recipientUserId === null && message.createdAt > lastReadAt).length;
}

export function resolvePersistedAgentMention(text: string, agents: FloorAgent[]): FloorAgent | null {
  const match = text.match(/@([A-Za-z][\w-]*)/);
  if (!match) return null;
  const name = match[1].toLocaleLowerCase("en-US");
  return agents.find((agent) => agent.name.toLocaleLowerCase("en-US") === name) ?? null;
}

export function shouldRefreshFloor(currentRevision: number, event: PresenceEvent) {
  return event.type === "floor.changed" && event.revision > currentRevision;
}

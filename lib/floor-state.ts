import type { FloorAgent, FloorMessage, FloorQueueItem } from "./floor-types";
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

export function firstMergeableQueueGroup(queue: FloorQueueItem[]): string[] {
  for (let index = 0; index < queue.length - 1; index += 1) {
    if (queue[index].status !== "queued") continue;
    const target = queue[index].agentId;
    const group = [queue[index].id];
    for (let next = index + 1; next < queue.length && queue[next].status === "queued" && queue[next].agentId === target; next += 1) group.push(queue[next].id);
    if (group.length > 1) return group;
  }
  return [];
}

export function shouldRefreshFloor(currentRevision: number, event: PresenceEvent) {
  return event.type === "floor.changed" && event.revision > currentRevision;
}

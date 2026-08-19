import type { FloorAgent, FloorQueueItem } from "./floor-types";
import type { PresenceEvent } from "./session-types";

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

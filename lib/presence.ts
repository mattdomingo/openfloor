import type { PresenceEvent } from "./session-types";

export function reducePresence(onlineUserIds: ReadonlySet<string>, event: PresenceEvent): Set<string> {
  if (event.type === "presence.snapshot") return new Set(event.onlineUserIds);
  if (event.type !== "presence.changed") return new Set(onlineUserIds);

  const next = new Set(onlineUserIds);
  if (event.online) next.add(event.userId);
  else next.delete(event.userId);
  return next;
}

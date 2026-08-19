import type { PresenceEvent, TypingDraft } from "./session-types";

export type DraftVisibility = "all" | "typing" | "hidden";

export function reduceTypingDrafts(
  drafts: ReadonlyMap<string, TypingDraft>,
  event: PresenceEvent,
): Map<string, TypingDraft> {
  if (event.type === "presence.snapshot") {
    return new Map(event.typingDrafts.map((draft) => [draft.userId, draft]));
  }
  if (event.type !== "typing.changed") return new Map(drafts);

  const next = new Map(drafts);
  if (!event.draft.text && !event.draft.typing) next.delete(event.draft.userId);
  else next.set(event.draft.userId, event.draft);
  return next;
}

export function visibleTypingDrafts<T extends { id: string }>(
  teammates: T[],
  drafts: ReadonlyMap<string, TypingDraft>,
  visibility: DraftVisibility,
): Array<T & { draft: TypingDraft | null }> {
  if (visibility === "hidden") return [];
  return teammates
    .map((teammate) => ({ ...teammate, draft: drafts.get(teammate.id) ?? null }))
    .filter(({ draft }) => visibility === "all" || draft?.typing === true);
}

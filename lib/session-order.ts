// Ordering rules for the home grid's per-device tile arrangement. Kept out of
// HomeScreen.tsx so tests/unit can exercise them under plain node — the
// component keeps the localStorage read/write, this file is pure.

export function parseSessionOrder(stored: string): string[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // A hand-edited or half-written value should fall back to server order,
    // never throw on render.
    return [];
  }
}

/* Sessions the stored order has never seen — created since, or arranged on
   another device — keep their server position behind the arranged ones,
   rather than jumping to the front or disappearing. */
export function sortByStoredOrder<T extends { id: string }>(sessions: T[], order: string[]): T[] {
  if (order.length === 0) return sessions;
  const rank = new Map(order.map((id, index) => [id, index]));
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const rankA = rank.get(a.session.id) ?? Infinity;
      const rankB = rank.get(b.session.id) ?? Infinity;
      return rankA === rankB ? a.index - b.index : rankA - rankB;
    })
    .map((entry) => entry.session);
}

/* A tab only ever permutes its own cards, so the ids it hands back are written
   into the slots those same ids already occupy in the full list. Archived and
   ended tiles therefore keep their relative places while Active is rearranged. */
export function mergeVisibleOrder(allIds: string[], nextVisible: string[]): string[] {
  const visible = new Set(nextVisible);
  let next = 0;
  return allIds.map((id) => (visible.has(id) ? nextVisible[next++] ?? id : id));
}

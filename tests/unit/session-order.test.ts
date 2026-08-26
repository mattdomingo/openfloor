import { describe, expect, it } from "vitest";
import { mergeVisibleOrder, parseSessionOrder, sortByStoredOrder } from "@/lib/session-order";

const sessions = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((entry) => entry.id);

describe("stored session order", () => {
  it("keeps server order when nothing has been arranged", () => {
    expect(ids(sortByStoredOrder(sessions("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
  });

  it("applies the arranged order", () => {
    expect(ids(sortByStoredOrder(sessions("a", "b", "c"), ["c", "a", "b"]))).toEqual(["c", "a", "b"]);
  });

  it("leaves sessions the order has never seen in server order behind the arranged ones", () => {
    // "new" was created after the arrangement, "gone" no longer exists.
    expect(ids(sortByStoredOrder(sessions("new", "b", "a"), ["gone", "a", "b"]))).toEqual(["a", "b", "new"]);
  });

  it("ignores stored values that are not a list of ids", () => {
    expect(parseSessionOrder("")).toEqual([]);
    expect(parseSessionOrder("{oops")).toEqual([]);
    expect(parseSessionOrder('{"a":1}')).toEqual([]);
    expect(parseSessionOrder('["a",2,null,"b"]')).toEqual(["a", "b"]);
  });
});

describe("merging one tab's order back into the full list", () => {
  it("rewrites only the slots the visible tab occupies", () => {
    // Active is [a, c]; archived b and ended d must not move.
    expect(mergeVisibleOrder(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "b", "a", "d"]);
  });

  it("is a no-op when the visible order is unchanged", () => {
    expect(mergeVisibleOrder(["a", "b", "c"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("handles a single-card tab", () => {
    expect(mergeVisibleOrder(["a", "b", "c"], ["b"])).toEqual(["a", "b", "c"]);
  });

  it("keeps the full list intact when the tab is empty", () => {
    expect(mergeVisibleOrder(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

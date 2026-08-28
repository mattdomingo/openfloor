import { describe, expect, it } from "vitest";
import { applyConflictSelections, buildConflictFileSnapshot, parseConflictHunks, type ConflictSnapshotFileRaw } from "@/lib/conflict-hunks";

describe("parseConflictHunks", () => {
  it("parses a single hunk with labeled markers", () => {
    const merged = "line1\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> refs/heads/openfloor-source-result\nline2\n";
    const hunks = parseConflictHunks(merged);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      index: 0, oursLabel: "HEAD", theirsLabel: "refs/heads/openfloor-source-result",
      oursLines: ["ours line"], theirsLines: ["theirs line"],
    });
  });

  it("parses multiple hunks in one file, indexed in document order", () => {
    const merged = [
      "a", "<<<<<<< HEAD", "ours1", "=======", "theirs1", ">>>>>>> theirs",
      "b", "<<<<<<< HEAD", "ours2", "=======", "theirs2", ">>>>>>> theirs",
      "c",
    ].join("\n") + "\n";
    const hunks = parseConflictHunks(merged);
    expect(hunks.map((hunk) => hunk.index)).toEqual([0, 1]);
    expect(hunks[0].oursLines).toEqual(["ours1"]);
    expect(hunks[1].theirsLines).toEqual(["theirs2"]);
  });

  it("returns no hunks for content with no markers", () => {
    expect(parseConflictHunks("plain file\nno conflicts\n")).toEqual([]);
  });

  it("handles a hunk with empty ours or theirs side", () => {
    const merged = "<<<<<<< HEAD\n=======\nadded\n>>>>>>> theirs\n";
    const hunks = parseConflictHunks(merged);
    expect(hunks[0].oursLines).toEqual([]);
    expect(hunks[0].theirsLines).toEqual(["added"]);
  });

  it("throws on an unterminated hunk (missing =======)", () => {
    expect(() => parseConflictHunks("<<<<<<< HEAD\nours only\n")).toThrow(/=======/);
  });

  it("throws on an unterminated hunk (missing >>>>>>>)", () => {
    expect(() => parseConflictHunks("<<<<<<< HEAD\nours\n=======\ntheirs\n")).toThrow(/>>>>>>>/);
  });
});

describe("applyConflictSelections", () => {
  const merged = "top\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> branch\nbottom\n";

  it("resolves to ours, preserving surrounding context verbatim", () => {
    expect(applyConflictSelections(merged, { 0: "ours" })).toBe("top\nours line\nbottom\n");
  });

  it("resolves to theirs", () => {
    expect(applyConflictSelections(merged, { 0: "theirs" })).toBe("top\ntheirs line\nbottom\n");
  });

  it("resolves to both, ours then theirs", () => {
    expect(applyConflictSelections(merged, { 0: "both" })).toBe("top\nours line\ntheirs line\nbottom\n");
  });

  it("accepts a Map in place of a plain object", () => {
    expect(applyConflictSelections(merged, new Map([[0, "ours" as const]]))).toBe("top\nours line\nbottom\n");
  });

  it("round-trips a file with no conflicts and no trailing newline unchanged when there is nothing to select", () => {
    const plain = "no conflicts here";
    expect(applyConflictSelections(plain, {})).toBe(plain);
  });

  it("preserves a missing trailing newline through resolution", () => {
    const noTrailing = "top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nbottom";
    expect(applyConflictSelections(noTrailing, { 0: "ours" })).toBe("top\nours\nbottom");
  });

  it("resolves multiple hunks independently", () => {
    const multi = [
      "a", "<<<<<<< HEAD", "ours1", "=======", "theirs1", ">>>>>>> theirs",
      "b", "<<<<<<< HEAD", "ours2", "=======", "theirs2", ">>>>>>> theirs",
      "c",
    ].join("\n") + "\n";
    expect(applyConflictSelections(multi, { 0: "ours", 1: "theirs" })).toBe("a\nours1\nb\ntheirs2\nc\n");
  });

  it("throws when a hunk has no selection", () => {
    expect(() => applyConflictSelections(merged, {})).toThrow(/No selection provided/);
  });

  it("throws when a selection names a hunk index that does not exist", () => {
    expect(() => applyConflictSelections(merged, { 0: "ours", 5: "theirs" })).toThrow(/unknown conflict hunk/);
  });

  it("throws on malformed input the same way parseConflictHunks does", () => {
    expect(() => applyConflictSelections("<<<<<<< HEAD\nours\n", { 0: "ours" })).toThrow(/=======/);
  });
});

describe("buildConflictFileSnapshot", () => {
  const raw = (patch: Partial<ConflictSnapshotFileRaw>): ConflictSnapshotFileRaw => ({
    path: "src/app.ts", kind: "content", merged: null, base: null, ours: null, theirs: null, truncated: false, ...patch,
  });

  it("parses a content file into real hunks", () => {
    const merged = "<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> branch\n";
    const snapshot = buildConflictFileSnapshot(raw({ kind: "content", merged }));
    expect(snapshot).toMatchObject({ kind: "content", unparseable: false });
    expect(snapshot.hunks).toHaveLength(1);
    expect(snapshot.hunks[0].oursLines).toEqual(["ours line"]);
  });

  it("marks a content file with malformed markers unparseable instead of throwing", () => {
    const snapshot = buildConflictFileSnapshot(raw({ kind: "content", merged: "<<<<<<< HEAD\nours only\n" }));
    expect(snapshot.unparseable).toBe(true);
    expect(snapshot.hunks).toEqual([]);
  });

  it("marks a content file with no captured body unparseable", () => {
    const snapshot = buildConflictFileSnapshot(raw({ kind: "content", merged: null }));
    expect(snapshot.unparseable).toBe(true);
  });

  it("builds a single whole-file hunk for delete_modify with theirs content on the theirs side", () => {
    const snapshot = buildConflictFileSnapshot(raw({ kind: "delete_modify", theirs: "kept content\n" }));
    expect(snapshot.hunks).toHaveLength(1);
    expect(snapshot.hunks[0].oursLines).toEqual([]);
    expect(snapshot.hunks[0].theirsLines).toEqual(["kept content"]);
  });

  it("builds a single whole-file hunk for modify_delete with ours content on the ours side", () => {
    const snapshot = buildConflictFileSnapshot(raw({ kind: "modify_delete", ours: "kept content\n" }));
    expect(snapshot.hunks).toHaveLength(1);
    expect(snapshot.hunks[0].oursLines).toEqual(["kept content"]);
    expect(snapshot.hunks[0].theirsLines).toEqual([]);
  });

  it("builds a binary file with one contentless hunk", () => {
    const snapshot = buildConflictFileSnapshot(raw({ kind: "binary" }));
    expect(snapshot.hunks).toEqual([{ index: 0, oursLabel: "Ours", theirsLabel: "Theirs", oursLines: [], theirsLines: [] }]);
  });
});

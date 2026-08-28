// Pure, dependency-free conflict-marker parsing and rewriting. No I/O: the
// snapshot capture (worker/agent-run-workflow.ts) supplies the raw merged
// file text, this module turns it into per-hunk structure for the resolver
// dialog, and turns a human's per-hunk choices back into resolved file text.
//
// Only the standard two-way marker format git leaves in the working tree is
// handled — <<<<<<< / ======= / >>>>>>> — since the merge that produces these
// files does not set merge.conflictStyle=diff3, so there is no |||||||
// (common-ancestor) section to parse. A "both" choice concatenates ours then
// theirs; there is no per-hunk "base" choice for the same reason.

export type ConflictChoice = "ours" | "theirs" | "both";

export type ConflictHunk = {
  index: number;
  oursLabel: string;
  theirsLabel: string;
  oursLines: string[];
  theirsLines: string[];
};

type ContextSegment = { type: "context"; lines: string[] };
type HunkSegment = { type: "hunk"; hunk: ConflictHunk };
type Segment = ContextSegment | HunkSegment;

type ConflictDocument = { segments: Segment[]; trailingNewline: boolean };

const OURS_MARKER = /^<<<<<<< ?(.*)$/;
const SPLIT_MARKER = /^=======$/;
const THEIRS_MARKER = /^>>>>>>> ?(.*)$/;

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** Throws on malformed/unterminated markers rather than guessing — callers
 * that read untrusted or unexpectedly-shaped content (the R2 snapshot) should
 * catch this per file and mark that file unparseable instead of failing the
 * whole request. */
function parseDocument(merged: string): ConflictDocument {
  const { lines, trailingNewline } = splitLines(merged);
  const segments: Segment[] = [];
  let context: string[] = [];
  let index = 0;
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    const oursMatch = OURS_MARKER.exec(line);
    if (!oursMatch) {
      context.push(line);
      cursor += 1;
      continue;
    }
    if (context.length > 0 || segments.length === 0) segments.push({ type: "context", lines: context });
    context = [];
    const oursLabel = oursMatch[1] ?? "";
    cursor += 1;
    const oursLines: string[] = [];
    while (cursor < lines.length && !SPLIT_MARKER.test(lines[cursor])) {
      oursLines.push(lines[cursor]);
      cursor += 1;
    }
    if (cursor >= lines.length) throw new Error("Unterminated conflict hunk: missing ======= separator");
    cursor += 1; // consume =======
    const theirsLines: string[] = [];
    let theirsLabel = "";
    let closed = false;
    while (cursor < lines.length) {
      const theirsMatch = THEIRS_MARKER.exec(lines[cursor]);
      if (theirsMatch) {
        theirsLabel = theirsMatch[1] ?? "";
        cursor += 1;
        closed = true;
        break;
      }
      theirsLines.push(lines[cursor]);
      cursor += 1;
    }
    if (!closed) throw new Error("Unterminated conflict hunk: missing >>>>>>> marker");
    segments.push({ type: "hunk", hunk: { index, oursLabel, theirsLabel, oursLines, theirsLines } });
    index += 1;
  }
  if (context.length > 0 || segments.length === 0) segments.push({ type: "context", lines: context });
  return { segments, trailingNewline };
}

/** Returns the ordered list of conflict hunks in a file's merged (marker-
 * containing) content. Throws on malformed markers — see parseDocument. */
export function parseConflictHunks(merged: string): ConflictHunk[] {
  return parseDocument(merged).segments
    .filter((segment): segment is HunkSegment => segment.type === "hunk")
    .map((segment) => segment.hunk);
}

/** Rewrites every hunk per its choice and reassembles the file byte-for-byte
 * outside the rewritten hunks, including a missing trailing newline. Throws
 * if a hunk present in `merged` has no entry in `choices`, or if `choices`
 * names a hunk index that doesn't exist — never silently leaves a marker. */
export function applyConflictSelections(merged: string, choices: Map<number, ConflictChoice> | Record<number, ConflictChoice>): string {
  const lookup = choices instanceof Map ? choices : new Map(Object.entries(choices).map(([key, value]) => [Number(key), value]));
  const document = parseDocument(merged);
  const hunkCount = document.segments.filter((segment) => segment.type === "hunk").length;
  for (const key of lookup.keys()) {
    if (key < 0 || key >= hunkCount) throw new Error(`Selection references unknown conflict hunk ${key}`);
  }
  const usedIndexes = new Set<number>();
  const lines: string[] = [];
  for (const segment of document.segments) {
    if (segment.type === "context") {
      lines.push(...segment.lines);
      continue;
    }
    const choice = lookup.get(segment.hunk.index);
    if (!choice) throw new Error(`No selection provided for conflict hunk ${segment.hunk.index}`);
    usedIndexes.add(segment.hunk.index);
    lines.push(...(choice === "ours" ? segment.hunk.oursLines : choice === "theirs" ? segment.hunk.theirsLines : [...segment.hunk.oursLines, ...segment.hunk.theirsLines]));
  }
  if (usedIndexes.size !== hunkCount) throw new Error("Not every conflict hunk received a selection");
  return joinLines(lines, document.trailingNewline);
}

// One conflicted file exactly as the sandbox capture script
// (worker/agent-run-workflow.ts) writes it to the snapshot artifact: raw
// base/ours/theirs (git stages 1/2/3, null when that stage doesn't exist —
// which side is missing is what tells buildConflictFileSnapshot below which
// special kind this is) plus the working-tree file with markers intact.
export type ConflictSnapshotFileRaw = {
  path: string;
  kind: "content" | "delete_modify" | "modify_delete" | "binary";
  merged: string | null;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  truncated: boolean;
};

export type ConflictFileKind = "content" | "delete_modify" | "modify_delete" | "binary";

export type ConflictFileSnapshot = {
  path: string;
  kind: ConflictFileKind;
  hunks: ConflictHunk[];
  unparseable: boolean;
  truncated: boolean;
};

/** Turns one raw captured file into its display/selection model. "content"
 * parses real marker hunks; the three whole-file kinds get a single
 * synthetic hunk at index 0 so the same {path, hunkIndex, choice} selection
 * shape covers every case — see AGENTS.md's Merge Resolver section. */
export function buildConflictFileSnapshot(raw: ConflictSnapshotFileRaw): ConflictFileSnapshot {
  if (raw.kind === "content") {
    if (raw.merged === null) return { path: raw.path, kind: "content", hunks: [], unparseable: true, truncated: raw.truncated };
    try {
      return { path: raw.path, kind: "content", hunks: parseConflictHunks(raw.merged), unparseable: false, truncated: raw.truncated };
    } catch {
      return { path: raw.path, kind: "content", hunks: [], unparseable: true, truncated: raw.truncated };
    }
  }
  if (raw.kind === "binary") {
    return { path: raw.path, kind: "binary", hunks: [{ index: 0, oursLabel: "Ours", theirsLabel: "Theirs", oursLines: [], theirsLines: [] }], unparseable: false, truncated: raw.truncated };
  }
  const deletedSideLabel = raw.kind === "delete_modify" ? "Deleted" : "Modified";
  const keptSideLabel = raw.kind === "delete_modify" ? "Modified" : "Deleted";
  const keptContent = (raw.kind === "delete_modify" ? raw.theirs : raw.ours) ?? "";
  const hunk: ConflictHunk = raw.kind === "delete_modify"
    ? { index: 0, oursLabel: deletedSideLabel, theirsLabel: keptSideLabel, oursLines: [], theirsLines: splitLines(keptContent).lines }
    : { index: 0, oursLabel: keptSideLabel, theirsLabel: deletedSideLabel, oursLines: splitLines(keptContent).lines, theirsLines: [] };
  return { path: raw.path, kind: raw.kind, hunks: [hunk], unparseable: false, truncated: raw.truncated };
}

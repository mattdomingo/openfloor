import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyConflictSelections, parseConflictHunks } from "./conflict-hunks.ts";
import type { ConflictSnapshotFileRaw } from "./conflict-hunks.ts";
import type { ManualConflictSelection } from "./conflict-resolution.ts";

export const MAX_CONFLICT_FILE_BYTES = 2_000_000;
export type ConflictBlob = { oid: string; mode: string };
export type CapturedConflictFile = ConflictSnapshotFileRaw & {
  fingerprint: string;
  stages: Array<ConflictBlob | null>;
  wholeFileOnly: boolean;
};
export type ConflictManifest = {
  version: 2;
  files: Array<{ path: string; fingerprint: string; file: string; kind: ConflictSnapshotFileRaw["kind"]; wholeFileOnly: boolean; hunkCount: number; canEdit: boolean }>;
};

function git(root: string, args: string[], limit = 100 * 1024 * 1024): Buffer {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args], { cwd: root, maxBuffer: limit, stdio: ["ignore", "pipe", "pipe"] });
}
function safePath(root: string, path: string) {
  if (!path || path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".git" || part === "")) throw new Error("Invalid conflict path");
  const absolute = resolve(root, path);
  let parent = dirname(absolute);
  while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
  const canonicalRoot = realpathSync(root);
  const canonicalParent = realpathSync(parent);
  if (!absolute.startsWith(`${resolve(root)}/`) || canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}/`)) throw new Error("Conflict path escapes workspace");
  return absolute;
}
function blob(root: string, stage: ConflictBlob | null) {
  if (!stage || !["100644", "100755", "120000"].includes(stage.mode)) return null;
  const size = Number(git(root, ["cat-file", "-s", stage.oid]).toString().trim());
  if (!Number.isSafeInteger(size) || size > MAX_CONFLICT_FILE_BYTES) return null;
  return git(root, ["cat-file", "blob", stage.oid], MAX_CONFLICT_FILE_BYTES + 1);
}

export function captureConflictFiles(root: string, extraPaths: string[] = []): CapturedConflictFile[] {
  const entries = new Map<string, Array<ConflictBlob | null>>();
  for (const entry of new TextDecoder("utf-8", { fatal: true }).decode(git(root, ["ls-files", "-u", "-z"])).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, oid, stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    const stages = entries.get(path) ?? [null, null, null];
    stages[Number(stage) - 1] = { mode, oid };
    entries.set(path, stages);
  }
  // A clean Git merge can still need an intent decision. Capture complete
  // candidate/source versions for the overlapping files in that case.
  for (const path of extraPaths) {
    if (entries.has(path)) continue;
    const stages = ["refs/heads/openfloor-source-base", "HEAD", "refs/heads/openfloor-source-result"].map((ref) => {
      const entry = git(root, ["ls-tree", "-z", ref, "--", path]).toString().split("\0")[0];
      if (!entry) return null;
      const [mode, , oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
      return { mode, oid };
    });
    entries.set(path, stages);
  }
  return [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([path, stages]) => {
    const absolute = safePath(root, path);
    const bodies = stages.map((stage) => blob(root, stage));
    const metadata = existsSync(absolute) ? lstatSync(absolute) : null;
    const regular = metadata?.isFile() && !metadata.isSymbolicLink();
    const mergedBytes = regular && metadata && metadata.size <= MAX_CONFLICT_FILE_BYTES ? readFileSync(absolute) : null;
    const isBinary = (body: Buffer | null) => {
      if (!body) return false;
      if (body.includes(0)) return true;
      try { new TextDecoder("utf-8", { fatal: true }).decode(body); return false; } catch { return true; }
    };
    const binary = bodies.some(isBinary) || isBinary(mergedBytes);
    const complete = stages.every((stage, index) => !stage || bodies[index] !== null);
    const merged = !binary && mergedBytes ? mergedBytes.toString() : null;
    const kind = binary ? "binary" : !stages[1] ? "delete_modify" : !stages[2] ? "modify_delete" : "content";
    let wholeFileOnly = binary || !complete || stages.some((stage) => stage && stage.mode !== "100644" && stage.mode !== "100755") || merged === null;
    if (!wholeFileOnly && kind === "content") {
      try { wholeFileOnly = parseConflictHunks(merged!).length === 0; } catch { wholeFileOnly = true; }
    }
    const mergedIdentity = regular ? git(root, ["hash-object", "--", path]).toString().trim() : null;
    const fingerprint = createHash("sha256").update(JSON.stringify({ path, stages, mergedIdentity })).digest("hex");
    return { path, kind, fingerprint, stages, wholeFileOnly, truncated: false, merged,
      base: !binary && bodies[0] ? bodies[0].toString() : null,
      ours: !binary && bodies[1] ? bodies[1].toString() : null,
      theirs: !binary && bodies[2] ? bodies[2].toString() : null };
  });
}

export function applyManualConflictResolution(root: string, expected: CapturedConflictFile[], selections: ManualConflictSelection[]) {
  const current = captureConflictFiles(root, expected.map((file) => file.path));
  if (current.length !== expected.length || current.some((file, index) => file.path !== expected[index].path || file.fingerprint !== expected[index].fingerprint)) throw new Error("Conflict content changed; refresh and confirm again.");
  const byPath = new Map<string, ManualConflictSelection[]>();
  for (const selection of selections) byPath.set(selection.path, [...(byPath.get(selection.path) ?? []), selection]);
  if (byPath.size !== expected.length || [...byPath.keys()].some((path) => !expected.some((file) => file.path === path))) throw new Error("Choose a result for every affected file.");
  // Validate and calculate every result before touching any file.
  const operations = expected.map((file) => {
    const choices = byPath.get(file.path)!;
    if (new Set(choices.map((choice) => choice.hunkIndex)).size !== choices.length) throw new Error("Duplicate conflict selection");
    if (choices.length === 1 && choices[0].hunkIndex === -1) {
      const choice = choices[0];
      if (choice.choice === "edited") {
        if (file.merged === null || file.stages.some((stage) => stage && stage.mode !== "100644" && stage.mode !== "100755") || typeof choice.content !== "string" || Buffer.byteLength(choice.content) > MAX_CONFLICT_FILE_BYTES) throw new Error("This file cannot accept an edited text result");
        return { file, content: choice.content, stage: undefined };
      }
      if (choice.choice !== "ours" && choice.choice !== "theirs") throw new Error("Choose one complete file version");
      return { file, content: undefined, stage: file.stages[choice.choice === "ours" ? 1 : 2] };
    }
    if (file.wholeFileOnly || file.merged === null || choices.some((choice) => choice.choice === "edited" || choice.hunkIndex < 0)) throw new Error("Choose a complete file version");
    return { file, content: applyConflictSelections(file.merged, new Map(choices.map((choice) => [choice.hunkIndex, choice.choice as "ours" | "theirs" | "both"]))), stage: undefined };
  });
  for (const { file, content, stage } of operations) {
    const absolute = safePath(root, file.path);
    if (content !== undefined) {
      if (existsSync(absolute) && !lstatSync(absolute).isFile()) throw new Error("The result path is not a regular file");
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      git(root, ["add", "--", file.path]);
    } else if (!stage) {
      git(root, ["rm", "-f", "--ignore-unmatch", "--", file.path]);
    } else {
      // Restore the exact blob and mode, including binary files and symlinks.
      git(root, ["update-index", "--add", "--cacheinfo", `${stage.mode},${stage.oid},${file.path}`]);
      git(root, ["checkout-index", "--force", "--", file.path]);
    }
  }
  if (git(root, ["ls-files", "-u", "-z"]).length) throw new Error("Unresolved Git entries remain");
  git(root, ["diff", "--cached", "--check"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, root, directory, input] = process.argv.slice(2);
  if (action === "capture") {
    const extra = input ? JSON.parse(readFileSync(input, "utf8")) as string[] : [];
    const files = captureConflictFiles(root, extra);
    mkdirSync(directory, { recursive: true });
    const manifest: ConflictManifest = { version: 2, files: files.map((file, index) => {
      const name = `${index}.json`;
      writeFileSync(`${directory}/${name}`, JSON.stringify(file));
      return { path: file.path, fingerprint: file.fingerprint, file: name, kind: file.kind, wholeFileOnly: file.wholeFileOnly, hunkCount: file.wholeFileOnly ? 0 : parseConflictHunks(file.merged!).length, canEdit: file.merged !== null && file.stages.every((stage) => !stage || stage.mode === "100644" || stage.mode === "100755") };
    }) };
    writeFileSync(`${directory}/manifest.json`, JSON.stringify(manifest));
    process.stdout.write(JSON.stringify(manifest));
  } else if (action === "apply") {
    const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8")) as ConflictManifest;
    const files = manifest.files.map((file) => JSON.parse(readFileSync(`${directory}/${file.file}`, "utf8")) as CapturedConflictFile);
    applyManualConflictResolution(root, files, JSON.parse(readFileSync(input, "utf8")) as ManualConflictSelection[]);
  } else throw new Error("Unknown conflict workspace operation");
}

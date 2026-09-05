import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Entry = { name: string; type?: "file" | "directory" | "symlink" | "hardlink" | "fifo"; content?: string; link?: string; size?: number };
const roots: string[] = [];
const helper = resolve("scripts/restore-session-store.py");
const makeArchive = `
import io, json, sys, tarfile
types = {"directory": tarfile.DIRTYPE, "symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE}
class Zeros:
    def read(self, size):
        return bytes(size)
with tarfile.open(sys.argv[1], "w:gz") as archive:
    for item in json.load(sys.stdin):
        entry = tarfile.TarInfo(item["name"])
        entry.type = types.get(item.get("type"), tarfile.REGTYPE)
        entry.linkname = item.get("link", "")
        content = item.get("content", "").encode()
        entry.size = item.get("size", len(content) if entry.isfile() else 0)
        archive.addfile(entry, (Zeros() if "size" in item else io.BytesIO(content)) if entry.isfile() else None)
`;

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(entries: Entry[]) {
  // macOS /var is a symlink; the helper deliberately requires canonical homes.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openfloor-restore-")));
  roots.push(root);
  const home = join(root, "home");
  const archive = join(root, "store.tgz");
  mkdirSync(home);
  const created = spawnSync("python3", ["-c", makeArchive, archive], { input: JSON.stringify(entries), encoding: "utf8" });
  expect(created.status, created.stderr).toBe(0);
  return { root, home, restore: (subdir = ".claude/projects") => spawnSync("python3", [helper, archive, home, subdir], { encoding: "utf8" }) };
}

describe("session transcript restore boundary", () => {
  it.each([".claude/projects", ".codex/sessions", ".qwen/projects"])("restores ordinary %s transcripts", (subdir) => {
    const content = '{"message":"Preserve résumé and 🪨"}\n';
    const state = fixture([{ name: subdir, type: "directory" }, { name: `${subdir}/nested/run.jsonl`, content }]);
    const result = state.restore(subdir);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(state.home, subdir, "nested/run.jsonl"), "utf8")).toBe(content);
  });

  it.each([
    { name: ".claude/projects/../../../escape", content: "unsafe" },
    { name: "/tmp/openfloor-escape", content: "unsafe" },
    { name: ".claude/settings.json", content: "unsafe" },
    { name: ".claude/projects/link", type: "symlink", link: "/tmp" },
    { name: ".claude/projects/link", type: "hardlink", link: ".claude/projects/good.jsonl" },
    { name: ".claude/projects/fifo", type: "fifo" },
  ] satisfies Entry[])("rejects unsafe archive entry $name ($type) before writing transcripts", (entry) => {
    const state = fixture([{ name: ".claude/projects/good.jsonl", content: "good" }, entry]);
    expect(state.restore().status).not.toBe(0);
    expect(readdirSync(state.home)).toEqual([]);
  });

  it("rejects advertised decompressed size over 64 MiB before extracting", () => {
    const state = fixture([{ name: ".claude/projects/oversized", size: 64 * 1024 * 1024 + 1 }]);
    const result = state.restore();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Transcript exceeds restore limits");
    expect(readdirSync(state.home)).toEqual([]);
  });

  it("rejects more than 10,000 entries before extracting", () => {
    const state = fixture(Array.from({ length: 10001 }, (_, index) => ({ name: `.claude/projects/${index}`, type: "directory" })));
    const result = state.restore();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Transcript exceeds restore limits");
    expect(readdirSync(state.home)).toEqual([]);
  });

  it("rejects negative entry sizes that could subtract from the archive bound", () => {
    const state = fixture([{ name: ".claude/projects", type: "directory", size: -1024 }]);
    expect(state.restore().status).not.toBe(0);
    expect(readdirSync(state.home)).toEqual([]);
  });

  it.each(["file", "directory"] as const)("rejects an existing parent symlink before creating a %s outside home", (type) => {
    const state = fixture([{ name: ".claude/projects/nested/result", type, content: "unsafe" }]);
    const outside = join(state.root, "outside");
    mkdirSync(outside);
    mkdirSync(join(state.home, ".claude"));
    symlinkSync(outside, join(state.home, ".claude/projects"));
    expect(state.restore().status).not.toBe(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses to overwrite existing transcript files", () => {
    const state = fixture([{ name: ".claude/projects/existing", content: "replacement" }]);
    const target = join(state.home, ".claude/projects/existing");
    mkdirSync(join(state.home, ".claude/projects"), { recursive: true });
    writeFileSync(target, "original");
    expect(state.restore().status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(existsSync(target)).toBe(true);
  });
});

import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRunArtifact } from "../../scripts/read-run-artifact.mjs";

const roots = vi.hoisted(() => ({ physical: "", logical: "/tmp/openfloor/artifact-test" }));
// Map the fixed production root onto a real temporary directory. All filesystem
// checks still run against actual files, including macOS's canonical /private/tmp.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const physical = (path: string) => path.startsWith(`${roots.logical}/`) ? roots.physical + path.slice(roots.logical.length) : path;
  return {
    ...fs,
    openSync: (path: string, flags: number) => fs.openSync(physical(path), flags),
    realpathSync: (path: string) => {
      const resolved = fs.realpathSync(physical(path));
      return roots.physical && resolved.startsWith(`${roots.physical}/`) ? roots.logical + resolved.slice(roots.physical.length) : resolved;
    },
  };
});

beforeEach(() => { roots.physical = realpathSync(mkdtempSync(`${tmpdir()}/openfloor-artifact-`)); });
afterEach(() => { rmSync(roots.physical, { recursive: true, force: true }); roots.physical = ""; });
const file = (name: string, content = "ordinary artifact") => { writeFileSync(`${roots.physical}/${name}`, content); return `${roots.logical}/${name}`; };

describe("trusted run artifact reader", () => {
  it("reads ordinary and empty regular files", () => {
    expect(readRunArtifact(file("result"), 100).toString()).toBe("ordinary artifact");
    expect(readRunArtifact(file("empty", ""), 100)).toHaveLength(0);
  });

  it("rejects oversized files unless bounded prefix mode is explicit", () => {
    const path = file("CLAUDE.md", "0123456789".repeat(1000));
    expect(() => readRunArtifact(path, 12)).toThrow("bounded regular file");
    expect(readRunArtifact(path, 12, { prefix: true }).toString()).toBe("012345678901");
    expect(readRunArtifact(file("short", "abc"), 12, { prefix: true }).toString()).toBe("abc");
  });

  it("rejects file symlinks in either mode", () => {
    file("target");
    symlinkSync("target", `${roots.physical}/link`);
    for (const prefix of [false, true]) expect(() => readRunArtifact(`${roots.logical}/link`, 100, { prefix })).toThrow("links");
  });

  it("rejects symlinked parent directories", () => {
    mkdirSync(`${roots.physical}/directory`);
    file("directory/result");
    symlinkSync("directory", `${roots.physical}/alias`);
    expect(() => readRunArtifact(`${roots.logical}/alias/result`, 100)).toThrow("links");
  });

  it("rejects hardlinks in either mode", () => {
    file("target");
    linkSync(`${roots.physical}/target`, `${roots.physical}/alias`);
    for (const prefix of [false, true]) expect(() => readRunArtifact(`${roots.logical}/alias`, 100, { prefix })).toThrow("bounded regular file");
  });

  it("rejects FIFOs without blocking and rejects directories", () => {
    execFileSync("mkfifo", [`${roots.physical}/pipe`]);
    mkdirSync(`${roots.physical}/directory`);
    for (const name of ["pipe", "directory"]) expect(() => readRunArtifact(`${roots.logical}/${name}`, 100)).toThrow("bounded regular file");
  });

  it("rejects traversal, unsupported locations and invalid bounds", () => {
    file("target");
    mkdirSync(`${roots.physical}/directory`);
    expect(() => readRunArtifact(`${roots.logical}/directory/../target`, 100)).toThrow("links");
    expect(() => readRunArtifact("/etc/passwd", 100)).toThrow("location");
    for (const limit of [0, -1, 1.5, NaN, Infinity, 100 * 1024 * 1024 + 1]) expect(() => readRunArtifact(`${roots.logical}/target`, limit)).toThrow("bound");
  });
});

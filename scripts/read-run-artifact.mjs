import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Called only after the execution PID namespace has exited. Reject every
 * symlink component and special file. Oversized results require explicit prefix
 * mode, which reads at most the bound rather than loading the whole file. */
export function readRunArtifact(path, limit, { prefix = false } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 * 1024 * 1024) throw new Error("Invalid artifact bound");
  if (!path.startsWith("/tmp/openfloor/") && !path.startsWith("/workspace/repository/")) throw new Error("Invalid artifact location");
  if (realpathSync(path) !== path) throw new Error("Artifact links are not allowed");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (!prefix && stat.size > limit)) throw new Error("Artifact is not a bounded regular file");
    const data = Buffer.alloc(Math.min(stat.size, limit));
    let length = 0;
    while (length < data.length) {
      const count = readSync(descriptor, data, length, data.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (length !== data.length || after.nlink !== 1 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Artifact changed during read");
    return data.subarray(0, length);
  } finally { closeSync(descriptor); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, bound, mode] = process.argv.slice(2);
  const limit = Number(bound);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 * 1024 * 1024) throw new Error("Invalid artifact bound");
  const data = readRunArtifact(path, limit, { prefix: mode === "prefix" });
  if (mode === "upload") {
    const response = await fetch(process.env.OPENFLOOR_BUNDLE_URL, { method: "POST", headers: { authorization: `Bearer ${process.env.OPENFLOOR_BUNDLE_TOKEN}`, "content-type": "application/x-git-bundle" }, body: data, redirect: "error", signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Artifact upload failed (${response.status})`);
    process.stdout.write(await response.text());
  } else process.stdout.write(mode === "base64" ? data.toString("base64") : data.toString("utf8"));
}

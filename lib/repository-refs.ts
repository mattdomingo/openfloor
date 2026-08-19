export type OpenFloorBranchKind = "candidate" | "run";

export function openFloorBranchName(sessionId: string, kind: OpenFloorBranchKind, recordId: string, candidateName?: string): string {
  const suffix = kind === "candidate" && candidateName
    ? `${branchSlug(candidateName)}-${shortId(recordId)}`
    : shortId(recordId);
  return `openfloor/${shortId(sessionId)}/${kind}/${suffix}`;
}

function shortId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length < 8) throw new TypeError("OpenFloor IDs must contain at least eight letters or digits");
  return normalized.slice(0, 8);
}

function branchSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "candidate";
}

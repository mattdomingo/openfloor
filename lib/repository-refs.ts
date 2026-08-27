export type OpenFloorBranchKind = "candidate" | "run";

export function openFloorBranchName(sessionId: string, kind: OpenFloorBranchKind, recordId: string, candidateName?: string): string {
  const suffix = kind === "candidate" && candidateName
    ? `${branchSlug(candidateName)}-${shortId(recordId)}`
    : shortId(recordId);
  return `openfloor/${shortId(sessionId)}/${kind}/${suffix}`;
}

function shortId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length < 8) throw new TypeError("openfloor IDs must contain at least eight letters or digits");
  return normalized.slice(0, 8);
}

// Exported so the create-session dialog can render an honest live preview of
// the branch that will be created, without a second slug implementation.
export function branchSlug(value: string): string {
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

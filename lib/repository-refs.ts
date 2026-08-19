export type OpenFloorBranchKind = "candidate" | "run";

export function openFloorBranchName(sessionId: string, kind: OpenFloorBranchKind, recordId: string): string {
  return `openfloor/${shortId(sessionId)}/${kind}/${shortId(recordId)}`;
}

function shortId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length < 8) throw new TypeError("OpenFloor IDs must contain at least eight letters or digits");
  return normalized.slice(0, 8);
}

import type { ConflictChoice } from "./conflict-hunks";

export type ConflictMode = "prepare" | "ai" | "manual";
export type ConflictPrompt = { id: string; authorUserId: string; authorName: string; text: string; runId: string };
export type ConflictProvenance = { incoming: ConflictPrompt[]; integrated: ConflictPrompt[]; requiresOwner: boolean };
export type ManualConflictSelection = { path: string; hunkIndex: number; choice: ConflictChoice | "edited"; content?: string };
export type ConflictProposalPayload =
  | { kind: "intent"; instruction: string }
  | { kind: "manual"; selections: ManualConflictSelection[] };
export type ConflictVote = { userId: string | null; name: string | null; action: "approve" | "reject" | "override"; reason: string | null; createdAt: number };
export type ConflictProposal = {
  id: string;
  payload: ConflictProposalPayload;
  createdBy: string | null;
  votes: ConflictVote[];
  requiredAuthorIds: string[];
  approvedAuthorIds: string[];
  requiresOwner: boolean;
  approved: boolean;
};
export type ConflictResolution = {
  revision: number;
  trigger: "git" | "overlap";
  mode: ConflictMode;
  snapshotId: string | null;
  candidateSha: string | null;
  provenance: ConflictProvenance;
  proposal: ConflictProposal | null;
  waitingReason: string | null;
  assessment?: ConflictAssessment | null;
  actions?: { canPropose: boolean; canOverride: boolean };
};
export type ConflictAssessment = {
  outcome: "compatible" | "decision_required" | "blocked";
  explanation: string;
  preservedPromptIds: string[];
  evidence: string[];
};

export function proposalApproval(provenance: ConflictProvenance, activeUserIds: string[], votes: ConflictVote[]) {
  const requiredAuthorIds = [...new Set([...provenance.incoming, ...provenance.integrated].map((prompt) => prompt.authorUserId))];
  const active = new Set(activeUserIds);
  const latest = new Map<string, ConflictVote>();
  for (const vote of votes) if (vote.userId) latest.set(vote.userId, vote);
  const approvedAuthorIds = requiredAuthorIds.filter((id) => active.has(id) && latest.get(id)?.action === "approve");
  const requiresOwner = provenance.requiresOwner || requiredAuthorIds.length === 0 || requiredAuthorIds.some((id) => !active.has(id));
  const override = votes.some((vote) => vote.action === "override");
  return { requiredAuthorIds, approvedAuthorIds, requiresOwner, approved: override || (!requiresOwner && approvedAuthorIds.length === requiredAuthorIds.length) };
}

export type ConflictMutation = (caseId: string, action: "answers" | "selections" | "decisions" | "resolve" | "snapshot" | "reload", input?: unknown) => Promise<{ ok: boolean; error?: string }>;

export class ConflictSnapshotError extends Error {}

import type { MergeConflictCase } from "./floor-types";

export function renderConflictResolverPrompt(input: {
  conflict: MergeConflictCase;
  sourceSummary: string | null;
  sourceConflictReason: string | null;
  sessionBrief: string;
}): string {
  const { conflict } = input;
  const paths = conflict.conflictPaths.length > 0
    ? conflict.conflictPaths.map((path) => `- ${path}`).join("\n")
    : "- The three-way merge completed cleanly; verify the combined intent.";
  const resolution = conflict.resolution;
  const provenance = resolution?.provenance;
  const bothIntents = provenance ? JSON.stringify(provenance, null, 2) : "Conflict provenance is unavailable. Request a human decision.";
  const proposal = resolution?.proposal?.approved ? JSON.stringify(resolution.proposal.payload) : "No approved human decision.";
  const failures = conflict.attempts.filter((attempt) => attempt.status === "failed").slice(-2).map((attempt) => attempt.summary).filter(Boolean).join("\n");
  const authoredPrompts = conflict.prompts.length > 0
    ? conflict.prompts.map((prompt) => `- ${prompt.authorName}: ${prompt.text}`).join("\n")
    : "- No original prompt text was recorded.";
  return `# Merge Resolver system run

You are resolving a real integration conflict for the original queue item. This is not a new product task. The workspace is a genuine three-way merge: HEAD is the latest candidate, the retained verified source result has been merged into it, and unresolved files contain Git conflict markers.

Preserve the intent of both the original authored prompts and the work already integrated into the current candidate. Resolve every unmerged entry, remove every conflict marker, and leave the complete candidate-relative resolution in the working tree. Do not create commits or branches; openfloor will run required checks and publish through its verified pipeline.

If repository evidence and the session brief are insufficient because a product decision is required, call openfloor_request_conflict_input with a concise explanation and one to three specific questions, then stop. Mutually exclusive authored outcomes (for example, light-only versus dark-only UI) always require that human-input tool. Chronology never selects a winner. Only the current proposal approved by affected authors or an explicit session-owner override can authorize sacrificing an authored outcome. Do not guess and do not continue editing after that tool succeeds.

Before finishing, call openfloor_report_conflict_resolution with outcome compatible, an explanation, every preserved prompt ID, and concrete evidence (files, tests actually run, and observed results). This report is mandatory before publication. A compatible report is not permission to override a human choice. If attribution is missing or repository evidence is insufficient, request input instead. Do not claim checks passed unless they actually ran. Do not modify unrelated features.

## Both sides' authored intent

${bothIntents.slice(0, 64_000)}
${bothIntents.length > 64_000 ? "Intent exceeds this context. Request human input; do not infer omitted requirements." : ""}

## Approved decision (only current approval is authoritative)

${proposal}

## Previous failure evidence

${failures || "No prior failures."}

## Conflict case

- Case: ${conflict.id}
- Original source run: ${conflict.sourceRunId}
- Latest source run: ${conflict.latestSourceRunId}
- Source summary: ${input.sourceSummary ?? "No source summary was recorded."}
- Integration reason: ${input.sourceConflictReason ?? conflict.conflictReason}
- Automatic attempts since the last human answer: ${conflict.automaticAttempts}

## Actual conflicting paths

${paths}

## Original authored prompts

${authoredPrompts}

## Historical decisions

Legacy answers and selections are audit only. Only the current approved proposal above authorizes a decision.

${input.sessionBrief}`;
}

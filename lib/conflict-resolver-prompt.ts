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
  const answers = conflict.questions.length > 0
    ? conflict.questions.map((question) => `- ${question.question}\n  Answer: ${question.answer ?? "Not answered"}${question.answeredByName ? ` (${question.answeredByName})` : ""}`).join("\n")
    : "- No human questions or answers yet.";
  const authoredPrompts = conflict.prompts.length > 0
    ? conflict.prompts.map((prompt) => `- ${prompt.authorName}: ${prompt.text}`).join("\n")
    : "- No original prompt text was recorded.";
  return `# Merge Resolver system run

You are resolving a real integration conflict for the original queue item. This is not a new product task. The workspace is a genuine three-way merge: HEAD is the latest candidate, the retained verified source result has been merged into it, and unresolved files contain Git conflict markers.

Preserve the intent of both the original authored prompts and the work already integrated into the current candidate. Resolve every unmerged entry, remove every conflict marker, and leave the complete candidate-relative resolution in the working tree. Do not create commits or branches; openfloor will run required checks and publish through its verified pipeline.

If repository evidence and the session brief are insufficient because a product decision is required, call openfloor_request_conflict_input with a concise explanation and one to three specific questions, then stop. Mutually exclusive authored outcomes (for example, light-only versus dark-only UI) always require that human-input tool. Chronology alone must never select a winner unless an author explicitly said that a later prompt supersedes the earlier intent. Do not guess and do not continue editing after that tool succeeds.

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

## Current human answers

${answers}

${input.sessionBrief}`;
}

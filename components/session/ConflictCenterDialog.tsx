"use client";

import { useMemo, useState } from "react";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { ConflictChoice, MergeConflictCase } from "@/lib/floor-types";
import { Icon, useDialogDismiss } from "./primitives";
import { Markdown } from "./Markdown";
import { ConflictResolverBody } from "./ConflictResolver";

/* The hero "Conflicts" button's popup: one home for every merge-conflict case
   on the candidate — what happened, what the automatic resolver already tried,
   and the way forward (answer its questions, owner retry, or the manual
   per-hunk resolver embedded as the last step). */

function needsPerson(conflict: MergeConflictCase): boolean {
  return conflict.status === "awaiting_input" || conflict.status === "failed";
}

export function ConflictCenterDialog({ sessionId, conflicts, initialCaseId, owner, currentUserId, busy, onClose, onResolve, onAnswer, onSubmitSelections }: {
  sessionId: string;
  conflicts: MergeConflictCase[];
  initialCaseId: string | null;
  owner: boolean;
  currentUserId: string;
  busy: boolean;
  onClose: () => void;
  onResolve: (caseId: string) => Promise<boolean>;
  onAnswer: (caseId: string, answers: Array<{ questionId: string; answer: string }>) => Promise<boolean>;
  onSubmitSelections: (caseId: string, snapshotRunId: string, selections: Array<{ path: string; hunkIndex: number; choice: ConflictChoice }>) => Promise<boolean>;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  // Open cases first, then most recently touched — the rail is a work list,
  // not a history log.
  const ordered = useMemo(() => [...conflicts].sort((a, b) => Number(b.status !== "resolved") - Number(a.status !== "resolved") || b.updatedAt - a.updatedAt), [conflicts]);
  const [selectedId, setSelectedId] = useState<string | null>(() => initialCaseId
    ?? conflicts.find((conflict) => conflict.status === "awaiting_input" || conflict.status === "failed" || conflict.status === "pending")?.id
    ?? ordered[0]?.id
    ?? null);
  const [view, setView] = useState<"case" | "manual">("case");
  const selected = conflicts.find((conflict) => conflict.id === selectedId) ?? ordered[0] ?? null;
  const openCount = conflicts.filter((conflict) => conflict.status !== "resolved").length;

  function selectCase(caseId: string) {
    setSelectedId(caseId);
    setView("case");
  }

  return <dialog className="dialog conflict-center" {...dialogProps} aria-labelledby="conflict-center-title">
    <div className="dialog-head">
      <div className="dialog-title">
        <h2 id="conflict-center-title">Merge conflicts</h2>
        <p>{conflicts.length === 0 ? "Nothing to resolve on this candidate." : `${openCount} open · ${conflicts.length} total`}</p>
      </div>
      <button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button>
    </div>
    <div className="dialog-body conflict-center-body">
      {ordered.length === 0 ? <p className="review-empty">No merge conflicts. A run that hits a real GitHub integration conflict shows up here with its automatic-resolution history.</p>
        : <>
          {ordered.length > 1 && <nav className="conflict-center-rail" aria-label="Conflict cases">
            <ul>{ordered.map((conflict) => <li key={conflict.id}>
              <button type="button" className="conflict-center-case" data-selected={selected?.id === conflict.id ? "true" : undefined} data-status={conflict.status} data-attention={needsPerson(conflict) ? "action" : undefined} onClick={() => selectCase(conflict.id)}>
                <strong>{conflict.agentName}</strong>
                <span className="queue-chip" data-kind="status" data-status={conflict.status}>{conflict.status.replace("_", " ")}</span>
                {conflict.prompts[0] && <span className="conflict-center-case-prompt">{conflict.prompts[0].text}</span>}
                <small>{conflict.conflictPaths.length} file{conflict.conflictPaths.length === 1 ? "" : "s"} · {conflict.attempts.length} attempt{conflict.attempts.length === 1 ? "" : "s"}</small>
              </button>
            </li>)}</ul>
          </nav>}
          {selected && (view === "manual"
            ? <ConflictResolverBody sessionId={sessionId} caseId={selected.id} busy={busy} onExit={() => setView("case")} onSubmitted={() => setView("case")} onSubmit={onSubmitSelections} />
            : <ConflictCasePanel conflict={selected} owner={owner} canAnswer={owner || selected.prompts.some((prompt) => prompt.authorUserId === currentUserId)} busy={busy} onResolve={onResolve} onAnswer={onAnswer} onOpenResolver={() => setView("manual")} />)}
        </>}
    </div>
  </dialog>;
}

function ConflictCasePanel({ conflict, owner, canAnswer, busy, onResolve, onAnswer, onOpenResolver }: {
  conflict: MergeConflictCase;
  owner: boolean;
  canAnswer: boolean;
  busy: boolean;
  onResolve: (caseId: string) => Promise<boolean>;
  onAnswer: (caseId: string, answers: Array<{ questionId: string; answer: string }>) => Promise<boolean>;
  onOpenResolver: () => void;
}) {
  const unanswered = conflict.questions.filter((question) => question.answer === null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = unanswered.length > 0 && unanswered.every((question) => answers[question.id]?.trim());
  async function submitAnswers(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    await onAnswer(conflict.id, unanswered.map((question) => ({ questionId: question.id, answer: answers[question.id].trim() })));
    setSubmitting(false);
  }
  const automaticAttempts = conflict.attempts.filter((attempt) => attempt.launchKind === "automatic").length;
  const canResolveManually = conflict.hasSnapshot && canAnswer && (conflict.status === "failed" || conflict.status === "awaiting_input");
  return <section className="conflict-case conflict-center-detail" data-status={conflict.status}>
    <div className="conflict-case-head"><strong>Merge Resolver</strong><span className="queue-chip" data-kind="status" data-status={conflict.status}>{conflict.status.replace("_", " ")}</span></div>
    {/* The guided narrative: say plainly that automation stopped, why, and
        what the person in front of the screen can do about it. */}
    {conflict.status === "awaiting_input" && <p className="conflict-center-nudge"><Icon name="alert" size={12} />Automatic resolution didn&rsquo;t finish — the resolver needs your answers below before it can continue.</p>}
    {conflict.status === "failed" && <p className="conflict-center-nudge"><Icon name="alert" size={12} />Automatic resolution didn&rsquo;t succeed — the resolver stopped after {automaticAttempts} automatic attempt{automaticAttempts === 1 ? "" : "s"}.{canResolveManually ? " You can retry it, or resolve the conflict manually below." : ""}</p>}
    <p>{conflict.explanation ?? conflict.conflictReason}</p>
    <dl><div><dt>Source</dt><dd>{conflict.agentName} · run {conflict.sourceRunId.slice(0, 8)}</dd></div><div><dt>Attempts</dt><dd>{conflict.automaticAttempts}/2 automatic attempts since last answer</dd></div></dl>
    {conflict.prompts.length > 0 && <><span className="label">Original intent</span><ul className="conflict-answer-audit">{conflict.prompts.map((prompt) => <li key={prompt.id}><strong>{prompt.authorName}</strong><p>{prompt.text}</p></li>)}</ul></>}
    {conflict.conflictPaths.length > 0 && <><span className="label">Affected paths</span><ul className="conflict-paths">{conflict.conflictPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></>}
    {conflict.attempts.length > 0 && <><span className="label">Resolver attempts</span><ul className="conflict-answer-audit">{conflict.attempts.map((attempt, index) => <li key={attempt.runId}><strong>Attempt {index + 1} · {attempt.launchKind} · {attempt.status.replace("_", " ")}</strong>{attempt.summary && <Markdown>{attempt.summary}</Markdown>}{attempt.checks.map((check) => <small key={check.command}>{check.status} · <code>{check.command}</code></small>)}</li>)}</ul></>}
    {conflict.questions.some((question) => question.answer !== null) && <ul className="conflict-answer-audit">{conflict.questions.filter((question) => question.answer !== null).map((question) => <li key={question.id}><strong>{question.question}</strong><p>{question.answer}</p><small>Answered by {question.answeredByName ?? "former member"}{question.answeredAt && <> · <LocalDateTime timestamp={question.answeredAt} /></>}</small></li>)}</ul>}
    {conflict.status === "awaiting_input" && unanswered.length > 0 && canAnswer && <form className="conflict-answer-form" onSubmit={submitAnswers}>{unanswered.map((question) => <label key={question.id}><span>{question.question}</span><textarea required maxLength={2000} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /></label>)}<button type="submit" className="button primary-button" disabled={busy || submitting || !canSubmit}>Submit answers</button><small>First complete submission wins. Team chat remains available for discussion.</small></form>}
    {conflict.status === "awaiting_input" && unanswered.length > 0 && !canAnswer && <p className="review-empty">Waiting for the session owner or an original prompt author to answer. Team chat remains available for discussion.</p>}
    <div className="conflict-case-actions">
      {owner && (conflict.status === "failed" || conflict.status === "pending") && <button type="button" className="button" disabled={busy} onClick={() => void onResolve(conflict.id)}>{conflict.status === "failed" ? "Retry Merge Resolver" : "Start Merge Resolver"}</button>}
      {/* Manual resolution needs the same snapshot the automatic resolver
          leaves behind on any attempt, and the same authorization as a
          free-text answer — the owner, or whoever's prompt is in conflict. */}
      {canResolveManually && (
        <button type="button" className="button" data-variant="quiet" disabled={busy} onClick={onOpenResolver}>
          Resolve manually
        </button>
      )}
    </div>
    {conflict.failureReason && <p className="objective-error">{conflict.failureReason}</p>}
  </section>;
}

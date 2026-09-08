"use client";

import { useState } from "react";
import type { MergeConflictCase } from "@/lib/floor-types";
import type { ConflictMutation } from "@/lib/conflict-resolution";
import { Icon, useDialogDismiss } from "./primitives";
import { ConflictResolverBody } from "./ConflictResolver";

export function ConflictCenterDialog({ sessionId, conflicts, initialCaseId, owner, currentUserId, busy, onClose, onMutation }: {
  sessionId: string; conflicts: MergeConflictCase[]; initialCaseId: string | null; owner: boolean;
  currentUserId: string; busy: boolean; onClose: () => void; onMutation: ConflictMutation;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const ordered = [...conflicts].sort((a, b) => Number(b.status !== "resolved") - Number(a.status !== "resolved") || b.updatedAt - a.updatedAt);
  const [selectedId, setSelectedId] = useState(initialCaseId ?? ordered[0]?.id);
  const selected = ordered.find((item) => item.id === selectedId) ?? ordered[0];
  return <dialog className="dialog conflict-center" {...dialogProps} aria-labelledby="conflict-center-title">
    <div className="dialog-head"><div className="dialog-title"><h2 id="conflict-center-title">Merge conflicts</h2><p>Preserve both features. Agree together when outcomes conflict.</p></div><button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button></div>
    <div className="dialog-body conflict-center-body">
      {ordered.length > 1 && <nav className="conflict-center-rail" aria-label="Conflict cases"><ul>{ordered.map((item) => <li key={item.id}><button type="button" className="conflict-center-case" aria-current={item.id === selected?.id ? "true" : undefined} onClick={() => setSelectedId(item.id)}><strong>{item.agentName}</strong><span>{item.status.replaceAll("_", " ")}</span><small>{item.prompts[0]?.text}</small></button></li>)}</ul></nav>}
      {selected ? <ConflictCasePanel key={selected.id} sessionId={sessionId} conflict={selected} owner={owner} currentUserId={currentUserId} busy={busy} onMutation={onMutation} /> : <p>No conflicts need attention.</p>}
    </div>
  </dialog>;
}

function ConflictCasePanel({ sessionId, conflict, owner, currentUserId, busy, onMutation }: {
  sessionId: string; conflict: MergeConflictCase; owner: boolean; currentUserId: string; busy: boolean; onMutation: ConflictMutation;
}) {
  const resolution = conflict.resolution;
  const [instruction, setInstruction] = useState("");
  const [draftSnapshot, setDraftSnapshot] = useState(resolution?.snapshotId);
  const [overrideReason, setOverrideReason] = useState("");
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const prompts = resolution ? [...resolution.provenance.incoming, ...resolution.provenance.integrated] : conflict.prompts;
  const canAct = resolution?.actions?.canPropose ?? (owner || prompts.some((prompt) => prompt.authorUserId === currentUserId) || (!resolution?.snapshotId && conflict.prompts.some((prompt) => prompt.authorUserId === currentUserId)));
  const available = canAct && !busy && !submitting && !conflict.currentResolverRunId && conflict.status !== "resolved";
  const proposal = resolution?.proposal;
  const staleDraft = Boolean(instruction && draftSnapshot !== resolution?.snapshotId);
  async function mutate(action: Parameters<ConflictMutation>[1], body?: unknown) {
    setSubmitting(true); setError(null);
    try {
      const result = await onMutation(conflict.id, action, body);
      if (!result.ok) setError(result.error ?? "This action could not be saved. Reload current state and retry.");
      return result;
    } finally { setSubmitting(false); }
  }
  if (manual) return <ConflictResolverBody sessionId={sessionId} conflict={conflict} busy={busy} onExit={() => setManual(false)} onMutation={onMutation} />;
  return <section className="conflict-case conflict-center-detail" data-status={conflict.status}>
    <div className="conflict-case-head"><strong>{resolution?.trigger === "overlap" ? "Overlapping features" : "Conflicting changes"}</strong><span role="status">{conflict.status.replaceAll("_", " ")}</span></div>
    <p>{conflict.explanation ?? conflict.conflictReason}</p>
    <p role="status">{resolution?.waitingReason ?? (conflict.status === "resolving" ? resolution?.mode === "prepare" ? "Preparing exact file versions…" : resolution?.mode === "manual" ? "Applying the agreed result, then running checks…" : "AI is checking both intents and validating the result…" : conflict.status === "resolved" ? "Resolution verified against the candidate." : "Waiting for execution capacity.")}</p>
    {([['Already in candidate', resolution?.provenance.integrated ?? []], ['Incoming feature', resolution?.provenance.incoming.length ? resolution.provenance.incoming : conflict.prompts]] as const).map(([label, items]) => <div key={label}><h3>{label}</h3>{items.length ? items.map((prompt) => <blockquote key={prompt.id}><strong>{prompt.authorName}</strong><p>{prompt.text}</p></blockquote>) : <p>Attribution unavailable. An explicit owner decision is required.</p>}</div>)}
    {resolution?.assessment && <section aria-label="AI assessment"><h3>What AI found</h3><p>{resolution.assessment.explanation}</p><ul>{resolution.assessment.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul><p>Preserved intents: {resolution.assessment.preservedPromptIds.map((id) => prompts.find((prompt) => prompt.id === id)?.text ?? id).join("; ") || "Not confirmed"}</p></section>}
    {!!conflict.conflictPaths.length && <details><summary>{conflict.conflictPaths.length} affected files</summary><ul className="conflict-paths">{conflict.conflictPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details>}
    {proposal && <section aria-label="Current proposal"><h3>Proposed outcome</h3>{proposal.payload.kind === "intent" ? <p>{proposal.payload.instruction}</p> : <><p>Apply the exact selected files and text. No AI rewrite.</p><details><summary>Review selected result</summary>{proposal.payload.selections.map((selection) => <div key={JSON.stringify([selection.path, selection.hunkIndex])}><code>{selection.path}</code><p>{selection.hunkIndex < 0 ? "Complete file" : `Section ${selection.hunkIndex + 1}`}: {selection.choice === "ours" ? "Candidate version" : selection.choice === "theirs" ? "Incoming version" : selection.choice === "both" ? "Concatenate candidate then incoming" : "Edited result"}</p>{selection.content !== undefined && <pre className="conflict-result-preview">{selection.content}</pre>}</div>)}</details></>}
      <ul>{proposal.requiredAuthorIds.map((id) => <li key={id}>{prompts.find((prompt) => prompt.authorUserId === id)?.authorName ?? "Former member"}: {proposal.approvedAuthorIds.includes(id) ? "Approved" : "Agreement needed"}</li>)}</ul>
      {proposal.requiresOwner && <p>Missing attribution or a departed author requires an explicit owner override.</p>}
      {proposal.votes.map((vote, index) => <p key={index}>{vote.name ?? "Former member"}: {vote.action}{vote.reason && ` — ${vote.reason}`}</p>)}
      {available && <div className="conflict-case-actions"><button className="button" disabled={proposal.approvedAuthorIds.includes(currentUserId)} onClick={() => void mutate("decisions", { revision: resolution!.revision, proposalId: proposal.id, action: "approve" })}>Approve proposal</button><button className="button" onClick={() => void mutate("decisions", { revision: resolution!.revision, proposalId: proposal.id, action: "reject" })}>Disagree</button></div>}
      {owner && available && <details><summary>Owner override</summary><label>Reason for overriding agreement<textarea maxLength={2000} value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /></label><button className="button" disabled={!overrideReason.trim()} onClick={() => void mutate("decisions", { revision: resolution!.revision, proposalId: proposal.id, action: "override", reason: overrideReason })}>Record owner override</button></details>}
    </section>}
    {canAct && conflict.status !== "resolved" && <>
      {resolution?.snapshotId && <form className="conflict-answer-form" onSubmit={(event) => { event.preventDefault(); void mutate("answers", { revision: resolution.revision, snapshotId: resolution.snapshotId, instruction }); }}><label>Propose a shared outcome<textarea maxLength={6000} value={instruction} onChange={(event) => { if (!instruction) setDraftSnapshot(resolution.snapshotId); setInstruction(event.target.value); }} placeholder="Describe how both features should behave, or explain which outcome should win." /></label>
        {staleDraft && <p role="alert">File versions changed. Your draft is preserved; compare current versions before reconfirming.<button type="button" className="button" onClick={() => setDraftSnapshot(resolution.snapshotId)}>I reviewed current versions</button></p>}
        <button className="button" type="submit" disabled={!available || !instruction.trim() || staleDraft}>Propose for agreement</button><small>Your proposal includes your approval. All affected authors must approve the same result.</small></form>}
      <div className="conflict-case-actions"><button className="button" disabled={!available || !resolution?.snapshotId} onClick={() => setManual(true)}>Resolve manually</button>
        <button className="button" disabled={!available || Boolean(proposal && !proposal.approved)} onClick={() => void mutate("resolve", { revision: resolution?.revision })}>{resolution?.snapshotId ? "Retry AI / approved result" : "Prepare file versions"}</button>
        <button className="button" disabled={!available} onClick={() => void mutate("snapshot", { revision: resolution?.revision })}>Refresh file versions</button></div>
    </>}
    {(error || conflict.failureReason) && <p className="objective-error" role="alert">{error ?? conflict.failureReason}</p>}
    <button className="button" disabled={submitting} onClick={() => void mutate("reload")}>Reload current state</button>
    {conflict.attempts.length > 0 && <details><summary>Execution and validation history</summary><ul>{conflict.attempts.map((attempt, index) => <li key={attempt.runId}><strong>Attempt {index + 1} · {attempt.status.replaceAll("_", " ")}</strong><p>{attempt.summary}</p>{attempt.checks.map((check) => <p key={check.command}>{check.status} · <code>{check.command}</code></p>)}</li>)}</ul></details>}
  </section>;
}

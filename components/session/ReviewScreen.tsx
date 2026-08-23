"use client";

import { useMemo, useState } from "react";
import type { FloorMessage, FloorParticipant, FloorReviewSnapshot, ReviewContributor } from "@/lib/floor-types";
import { agentTone } from "./data";
import { Icon, useDialogDismiss } from "./primitives";
import { TeamChat } from "./TeamChat";

type PendingAction = { type: "merge"; deleteCandidateBranch: boolean } | { type: "deleteBranch" };

export function ReviewScreen({ review, owner, busy, blockingRunId, onReady, onMerge, onDeleteBranch, onCancelRun, teamChat, onSendTeamMessage, participants, currentUserId }: {
  review: FloorReviewSnapshot | null;
  owner: boolean;
  busy: boolean;
  blockingRunId: string | null;
  onReady: () => Promise<void>;
  onMerge: (deleteCandidateBranch: boolean) => Promise<boolean>;
  onDeleteBranch: () => Promise<boolean>;
  onCancelRun: (runId: string) => Promise<void>;
  teamChat: FloorMessage[];
  onSendTeamMessage: (text: string, recipientUserId: string | null) => Promise<boolean>;
  participants: FloorParticipant[];
  currentUserId: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(review?.files[0]?.id ?? null);
  const selected = useMemo(() => review?.files.find((file) => file.id === selectedId) ?? review?.files[0] ?? null, [review, selectedId]);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [retrying, setRetrying] = useState(false);

  async function runMerge(deleteCandidateBranch: boolean) {
    setMergeConfirmOpen(false);
    setPendingAction({ type: "merge", deleteCandidateBranch });
    await onMerge(deleteCandidateBranch);
  }

  async function runDeleteBranch() {
    setDeleteConfirmOpen(false);
    setPendingAction({ type: "deleteBranch" });
    await onDeleteBranch();
  }

  async function cancelBlockingRunAndRetry() {
    if (!blockingRunId || !pendingAction) return;
    setRetrying(true);
    await onCancelRun(blockingRunId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const ok = pendingAction.type === "merge" ? await onMerge(pendingAction.deleteCandidateBranch) : await onDeleteBranch();
      if (ok) break;
    }
    setRetrying(false);
    setPendingAction(null);
  }

  if (!review) {
    return <section className="review-screen" aria-label="Review"><div className="review-empty-state"><Icon name="branch" size={22} /><h2>No review available</h2><p>Files, checks, warnings, and approval controls will appear only after a connected agent backend creates a real review candidate.</p></div><section className="review-pane review-team-chat" aria-label="Team chat"><div className="review-pane-head"><h3>Team chat</h3><span>{teamChat.filter((message) => message.recipientUserId === null).length}</span></div><TeamChat messages={teamChat} onSend={onSendTeamMessage} participants={participants} currentUserId={currentUserId} /></section></section>;
  }

  const additions = review.files.reduce((total, file) => total + file.additions, 0);
  const deletions = review.files.reduce((total, file) => total + file.deletions, 0);
  const commitLabel = review.commitSha ? review.commitSha.slice(0, 8) : "Not committed";
  const canMerge = review.status === "ready" && review.pullRequest?.state === "open" && review.pullRequest.mergeable === true && review.pullRequest.mergeableState === "clean" && review.githubChecksPassing === true && !review.integrationRunId;
  return <section className="review-screen" aria-label="Review candidate">
    <header className="review-hero"><div className="review-hero-copy"><h2 className="review-title">Review</h2><div className="review-branch-summary"><span className="label">Candidate branch</span><h3><Icon name="branch" size={16} />{review.branch}</h3><p>{review.pullRequest ? <a href={review.pullRequest.url} target="_blank" rel="noreferrer">{review.pullRequest.draft ? "Draft " : ""}PR #{review.pullRequest.number} · {review.pullRequest.merged ? "merged" : review.pullRequest.state}</a> : "Waiting for the candidate pull request."}</p></div></div><div className="review-hero-facts"><div><span className="label">Commit</span><strong className="value" title={review.commitSha ?? undefined}>{commitLabel}</strong></div><div><span className="label">Base</span><strong className="value">{review.baseBranch}</strong></div><div><span className="label">Diff</span><strong><span className="add">+{additions}</span> <span className="del">−{deletions}</span></strong></div><div><span className="label">Status</span><strong>{review.status}</strong></div><div><span className="label">Mergeability</span><strong>{review.pullRequest?.mergeable == null ? "unknown" : review.pullRequest.mergeable ? review.pullRequest.mergeableState ?? "mergeable" : "blocked"}</strong></div><div><span className="label">GitHub checks</span><strong>{review.githubChecksPassing == null ? "not synchronized" : review.githubChecksPassing ? "passing" : "blocked"}</strong></div></div>{owner && review.pullRequest && review.status !== "merged" && <div className="review-actions"><button type="button" className="button" disabled={busy} onClick={() => void onReady()}>{review.status === "draft" ? "Ready for review" : "Refresh GitHub status"}</button><button type="button" className="button primary-button" disabled={busy || !canMerge} title={canMerge ? "Squash merge through GitHub" : review.integrationRunId ? "A run is still integrating into this candidate" : "The PR must be ready, mergeable, and passing checks"} onClick={() => setMergeConfirmOpen(true)}>Squash merge</button></div>}</header>
    <div className="review-grid"><aside className="review-pane" aria-label="Changed files"><div className="review-pane-head"><h3>Files changed</h3><span>{review.files.length}</span></div>{review.files.length === 0 ? <p className="review-empty">No changed files.</p> : <ul className="review-file-list">{review.files.map((file) => <li key={file.id}><button type="button" className="review-file" data-selected={selected?.id === file.id ? "true" : "false"} onClick={() => setSelectedId(file.id)}><span className="file-copy" title={file.path}><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span><FileAttribution contributors={file.contributors} /></span><span className="diff-stat"><i className="add">+{file.additions}</i><i className="del">−{file.deletions}</i></span></button></li>)}</ul>}</aside>
      <section className="review-pane review-diff" aria-label="Diff preview"><div className="review-pane-head"><h3>{selected?.path ?? "Diff preview"}</h3>{selected && <FileAttribution contributors={selected.contributors} expanded />}</div>{selected?.summary && <p className="review-summary">{selected.summary}</p>}{selected && selected.diff.length > 0 ? <pre className="review-code" aria-label={`Diff preview for ${selected.path}`}>{selected.diff.map((line, index) => <span key={`${index}-${line.text}`} className="review-line" data-type={line.type}><i>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</i><code>{line.text}</code></span>)}</pre> : <p className="review-empty">No diff preview available.</p>}</section>
      <aside className="review-side"><section className="review-pane" aria-label="Integration warnings"><div className="review-pane-head"><h3>Integration</h3><span>{review.warnings.length}</span></div>{review.warnings.length === 0 ? <p className="review-empty">No integration warnings.</p> : <ul className="review-warning-list">{review.warnings.map((warning) => <li key={warning.id} data-severity={warning.severity}><strong>{warning.title}</strong><p>{warning.detail}</p></li>)}</ul>}</section><section className="review-pane" aria-label="Checks"><div className="review-pane-head"><h3>Checks</h3><span>{review.checks.length}</span></div>{review.checks.length === 0 ? <p className="review-empty">No checks reported by GitHub or openfloor.</p> : <ul className="review-check-list">{review.checks.map((check) => <li key={check.id}><span className="check-mark" aria-label={check.state}>{check.state === "passed" ? "✓" : check.state === "failed" ? "!" : "…"}</span><div><strong>{check.name}</strong>{check.detail && <span>{check.detail}</span>}</div></li>)}</ul>}</section>{review.status === "merged" && <section className="review-pane" aria-label="Branch cleanup"><div className="review-pane-head"><h3>Branch cleanup</h3><span>{review.cleanupStatus ?? "pending"}</span></div><p className="review-empty">{review.cleanupStatus === "complete" ? "Recorded candidate and run branches were deleted after exact-SHA verification." : "Any branch that did not match its recorded SHA was preserved."}</p>{owner && !review.branchDeletedAt && <div className="review-actions"><button type="button" className="button danger-button" disabled={busy || retrying} onClick={() => setDeleteConfirmOpen(true)}>Delete candidate branch</button></div>}</section>}<section className="review-pane review-team-chat" aria-label="Team chat"><div className="review-pane-head"><h3>Team chat</h3><span>{teamChat.filter((message) => message.recipientUserId === null).length}</span></div><TeamChat messages={teamChat} onSend={onSendTeamMessage} participants={participants} currentUserId={currentUserId} /></section></aside>
    </div>
    {mergeConfirmOpen && <MergeConfirmDialog busy={busy} onClose={() => setMergeConfirmOpen(false)} onConfirm={runMerge} />}
    {deleteConfirmOpen && <DeleteBranchConfirmDialog branch={review.branch} busy={busy} onClose={() => setDeleteConfirmOpen(false)} onConfirm={runDeleteBranch} />}
    {blockingRunId && pendingAction && <IntegrationBlockedDialog retrying={retrying} onClose={() => setPendingAction(null)} onConfirm={cancelBlockingRunAndRetry} />}
  </section>;
}

function requesterLabel(requestedBy: ReviewContributor["requestedBy"]) {
  if (requestedBy.length === 0) return "someone";
  if (requestedBy.length <= 2) return requestedBy.map((requester) => requester.userName).join(", ");
  return `${requestedBy[0].userName} +${requestedBy.length - 1}`;
}

function contributorTitle(contributors: ReviewContributor[]) {
  return contributors.map((contributor) => `${contributor.agentName} · asked by ${contributor.requestedBy.map((requester) => requester.userName).join(", ")}`).join("\n");
}

function FileAttribution({ contributors, expanded }: { contributors: ReviewContributor[]; expanded?: boolean }) {
  if (contributors.length === 0) return <span className="review-attribution is-empty">Unattributed</span>;
  if (expanded) return <span className="review-attribution" data-expanded="true">{contributors.map((contributor) => <span key={contributor.agentId} className="review-attribution-row" data-tone={agentTone(contributor.agentId)}><span className="queue-chip" data-kind="agent" data-tone={agentTone(contributor.agentId)}>{contributor.agentName}</span><span className="review-attribution-who">asked by {requesterLabel(contributor.requestedBy)}</span></span>)}</span>;
  const [first, ...rest] = contributors;
  return <span className="review-attribution" data-tone={agentTone(first.agentId)} title={contributorTitle(contributors)}><span className="queue-chip" data-kind="agent" data-tone={agentTone(first.agentId)}>{first.agentName}</span><span className="review-attribution-who">asked by {requesterLabel(first.requestedBy)}</span>{rest.length > 0 && <span className="review-attribution-more">+{rest.length}</span>}</span>;
}

function MergeConfirmDialog({ busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: (deleteCandidateBranch: boolean) => Promise<void> }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="merge-confirm-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="merge-confirm-title">Squash merge this candidate?</h2><p>The pull request merges into the base branch and the session ends. Run branches are always cleaned up — decide what happens to the candidate branch itself.</p></div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={() => void onConfirm(false)} disabled={busy}>Merge, keep branch</button>
        <button type="button" className="button primary-button" onClick={() => void onConfirm(true)} disabled={busy}>Merge, delete branch</button>
      </div>
    </dialog>
  );
}

function DeleteBranchConfirmDialog({ branch, busy, onClose, onConfirm }: { branch: string; busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="delete-branch-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="delete-branch-title">Delete “{branch}”?</h2><p>This deletes the merged candidate branch on GitHub. It cannot be undone.</p></div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        <button type="button" className="button danger-button" onClick={() => void onConfirm()} disabled={busy}>Delete branch</button>
      </div>
    </dialog>
  );
}

function IntegrationBlockedDialog({ retrying, onClose, onConfirm }: { retrying: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="integration-blocked-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="integration-blocked-title">A run is still integrating</h2><p>A run is actively merging into this candidate branch, so this action is blocked until it finishes. You can cancel that run and retry, or wait and try again yourself.</p></div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={retrying}>Wait</button>
        <button type="button" className="button danger-button" onClick={() => void onConfirm()} disabled={retrying}>{retrying ? "Cancelling…" : "Cancel that run & retry"}</button>
      </div>
    </dialog>
  );
}

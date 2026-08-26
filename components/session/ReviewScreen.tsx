"use client";

import { useEffect, useMemo, useState } from "react";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { FloorMessage, FloorParticipant, FloorReviewSnapshot, MergeConflictCase, ReviewContributor } from "@/lib/floor-types";
import type { RepositoryTreeEntry } from "@/lib/github";
import type { RepositoryConnection } from "@/lib/session-types";
import { agentTone } from "./data";
import { Icon, SegmentedControl, useDialogDismiss } from "./primitives";
import { TeamChat } from "./TeamChat";
import type { RepositorySource } from "./useRepositoryTree";

type PendingAction = { type: "merge"; deleteCandidateBranch: boolean } | { type: "deleteBranch" } | { type: "abandon"; deleteBranch: boolean };
type Selection = { kind: "changed"; id: string } | { kind: "repo"; path: string };
const DISCONNECTED_STATUSES = new Set(["disconnected", "revoked", "inaccessible"]);

export function ReviewScreen({ review, repository, repositoryTree, selectedConflictCaseId, owner, busy, blockingRunId, onReady, onMerge, onDeleteBranch, onAbandon, onCancelRun, onResolveConflict, onAnswerConflict, teamChat, onSendTeamMessage, participants, currentUserId }: {
  review: FloorReviewSnapshot | null;
  repository: RepositoryConnection | null;
  repositoryTree: RepositorySource;
  selectedConflictCaseId: string | null;
  owner: boolean;
  busy: boolean;
  blockingRunId: string | null;
  onReady: () => Promise<void>;
  onMerge: (deleteCandidateBranch: boolean) => Promise<boolean>;
  onDeleteBranch: () => Promise<boolean>;
  onAbandon: (deleteBranch: boolean) => Promise<boolean>;
  onCancelRun: (runId: string) => Promise<void>;
  onResolveConflict: (caseId: string) => Promise<boolean>;
  onAnswerConflict: (caseId: string, answers: Array<{ questionId: string; answer: string }>) => Promise<boolean>;
  teamChat: FloorMessage[];
  onSendTeamMessage: (text: string, recipientUserId: string | null) => Promise<boolean>;
  participants: FloorParticipant[];
  currentUserId: string;
}) {
  const repositoryBrowsable = repository != null && !DISCONNECTED_STATUSES.has(repository.status);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tabOverride, setTabOverride] = useState<"changed" | "all" | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [abandonConfirmOpen, setAbandonConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [retrying, setRetrying] = useState(false);

  const hasChangedFiles = Boolean(review && review.files.length > 0);
  const activeTab: "changed" | "all" = tabOverride ?? (hasChangedFiles ? "changed" : "all");
  const fileTree = useMemo(() => repositoryTree.tree ? buildFileTree(repositoryTree.tree.entries) : [], [repositoryTree.tree]);

  // Fires once per candidate head: the hook's own idempotency guard (and the
  // reset it gets on a "repository" floor-domain push) make repeated calls a
  // no-op, so this doesn't need a tighter dependency list.
  useEffect(() => {
    if (repositoryBrowsable && repositoryTree.treeState === "idle") repositoryTree.load();
  }, [repositoryBrowsable, repositoryTree]);

  // Self-heals like the pre-tree version did: falls back to the first changed
  // file whenever the current selection stops existing (a new run, a merge),
  // but leaves a repo-path selection alone since the tree doesn't move.
  const selected = useMemo<Selection | null>(() => {
    if (selection?.kind === "changed" && review?.files.some((file) => file.id === selection.id)) return selection;
    if (selection?.kind === "repo") return selection;
    if (review && review.files.length > 0) return { kind: "changed", id: review.files[0].id };
    return null;
  }, [selection, review]);

  const selectedChangedFile = selected?.kind === "changed" ? review?.files.find((file) => file.id === selected.id) ?? null : null;
  const selectedRepoPath = selected?.kind === "repo" ? selected.path : null;
  const selectedRepoFile = selectedRepoPath ? repositoryTree.fileFor(selectedRepoPath) : null;
  const selectedRepoFileState = selectedRepoPath ? repositoryTree.fileStateFor(selectedRepoPath) : "idle";

  function selectChanged(id: string) {
    setTabOverride("changed");
    setSelection({ kind: "changed", id });
  }

  function selectRepoPath(path: string) {
    const changedMatch = review?.files.find((file) => file.path === path);
    if (changedMatch) {
      selectChanged(changedMatch.id);
      return;
    }
    setSelection({ kind: "repo", path });
    repositoryTree.loadFile(path);
  }

  function toggleDir(path: string) {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

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

  async function runAbandon(deleteBranch: boolean) {
    setAbandonConfirmOpen(false);
    setPendingAction({ type: "abandon", deleteBranch });
    await onAbandon(deleteBranch);
  }

  async function cancelBlockingRunAndRetry() {
    if (!blockingRunId || !pendingAction) return;
    setRetrying(true);
    await onCancelRun(blockingRunId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const ok = pendingAction.type === "merge" ? await onMerge(pendingAction.deleteCandidateBranch)
        : pendingAction.type === "abandon" ? await onAbandon(pendingAction.deleteBranch)
        : await onDeleteBranch();
      if (ok) break;
    }
    setRetrying(false);
    setPendingAction(null);
  }

  const teamChatPane = <section className="review-pane review-team-chat" aria-label="Team chat"><div className="review-pane-head"><h3>Team chat</h3><span>{teamChat.filter((message) => message.recipientUserId === null).length}</span></div><TeamChat messages={teamChat} onSend={onSendTeamMessage} participants={participants} currentUserId={currentUserId} /></section>;

  const filesPane = <aside className="review-pane" aria-label="Repository files">
    {review ? <div className="review-pane-head"><SegmentedControl label="Files view" value={activeTab} onChange={setTabOverride} options={[{ value: "changed", label: `Changed (${review.files.length})` }, { value: "all", label: "All files" }]} /></div> : <div className="review-pane-head"><h3>All files</h3></div>}
    {activeTab === "changed" && review ? (
      review.files.length === 0 ? <p className="review-empty">No changed files.</p> : <ul className="review-file-list">{review.files.map((file) => <li key={file.id}><button type="button" className="review-file" data-selected={selectedChangedFile?.id === file.id ? "true" : "false"} onClick={() => selectChanged(file.id)}><span className="file-copy" title={file.path}><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span><FileAttribution contributors={file.contributors} /></span><span className="diff-stat"><i className="add">+{file.additions}</i><i className="del">−{file.deletions}</i></span></button></li>)}</ul>
    ) : (
      repositoryTree.treeState === "loading" || repositoryTree.treeState === "idle" ? <p className="review-empty">Loading repository files…</p>
        : repositoryTree.treeState === "error" ? <p className="review-empty">The repository tree could not be loaded.</p>
        : fileTree.length === 0 ? <p className="review-empty">This repository has no files.</p>
        : <div className="review-tree" role="tree" aria-label="Repository files">
            <RepositoryTreeBranch nodes={fileTree} depth={0} expandedDirs={expandedDirs} onToggleDir={toggleDir} selectedPath={selectedRepoPath} onSelectFile={selectRepoPath} />
            {repositoryTree.tree?.truncated && <p className="review-empty">Showing a partial file list — this repository is very large.</p>}
          </div>
    )}
  </aside>;

  const centerPane = selectedChangedFile ? (
    <section className="review-pane review-diff" aria-label="Diff preview"><div className="review-pane-head"><h3>{selectedChangedFile.path}</h3><FileAttribution contributors={selectedChangedFile.contributors} expanded /></div>{selectedChangedFile.summary && <p className="review-summary">{selectedChangedFile.summary}</p>}{selectedChangedFile.diff.length > 0 ? <pre className="review-code" aria-label={`Diff preview for ${selectedChangedFile.path}`}>{selectedChangedFile.diff.map((line, index) => <span key={`${index}-${line.text}`} className="review-line" data-type={line.type}><i>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</i><code>{line.text}</code></span>)}</pre> : <p className="review-empty">No diff preview available.</p>}</section>
  ) : selectedRepoPath ? (
    <section className="review-pane review-diff review-file-pane" aria-label="File preview"><div className="review-pane-head"><h3>{selectedRepoPath}</h3></div>{
      selectedRepoFileState === "idle" || selectedRepoFileState === "loading" ? <p className="review-empty">Loading file…</p>
        : selectedRepoFileState === "error" ? <p className="review-empty">This file could not be loaded.</p>
        : selectedRepoFile?.encoding === "text" ? <>{selectedRepoFile.truncated && <p className="review-summary">Showing the first {selectedRepoFile.text.split("\n").length.toLocaleString()} lines.</p>}<pre className="review-code" aria-label={`File preview for ${selectedRepoPath}`}>{selectedRepoFile.text.split("\n").map((text, index) => <span key={index} className="review-line" data-type="context"><i> </i><code>{text}</code></span>)}</pre></>
        : selectedRepoFile?.encoding === "too_large" ? <p className="review-empty">This file is too large to preview.</p>
        : <p className="review-empty">This file is binary and can’t be previewed.</p>
    }</section>
  ) : (
    <section className="review-pane review-diff" aria-label="Diff preview"><div className="review-empty-state"><Icon name="branch" size={22} /><h2>No review available</h2><p>Files, checks, warnings, and approval controls will appear only after a connected agent backend creates a real review candidate.</p></div></section>
  );

  if (!review) {
    if (!repositoryBrowsable) {
      return <section className="review-screen" aria-label="Review"><div className="review-empty-state"><Icon name="branch" size={22} /><h2>No review available</h2><p>Files, checks, warnings, and approval controls will appear only after a connected agent backend creates a real review candidate.</p></div>{teamChatPane}</section>;
    }
    return <section className="review-screen" aria-label="Review candidate">
      <div className="review-grid">{filesPane}{centerPane}<aside className="review-side">{teamChatPane}</aside></div>
    </section>;
  }

  const additions = review.files.reduce((total, file) => total + file.additions, 0);
  const deletions = review.files.reduce((total, file) => total + file.deletions, 0);
  const commitLabel = review.commitSha ? review.commitSha.slice(0, 8) : "Not committed";
  const canMerge = review.status === "ready" && review.pullRequest?.state === "open" && review.pullRequest.mergeable === true && review.pullRequest.mergeableState === "clean" && review.githubChecksPassing === true && !review.integrationRunId;
  const isMerged = review.status === "merged";
  const isAbandoned = review.status === "abandoned";
  return <section className="review-screen" aria-label="Review candidate">
    <header className="review-hero"><div className="review-hero-copy"><h2 className="review-title">Review</h2><div className="review-branch-summary"><span className="label">Candidate branch</span><h3><Icon name="branch" size={16} />{review.branch}</h3><p>{review.pullRequest ? <a href={review.pullRequest.url} target="_blank" rel="noreferrer">{review.pullRequest.draft ? "Draft " : ""}PR #{review.pullRequest.number} · {review.pullRequest.merged ? "merged" : review.pullRequest.state}</a> : "Waiting for the candidate pull request."}</p></div></div><div className="review-hero-facts"><div><span className="label">Commit</span><strong className="value" title={review.commitSha ?? undefined}>{commitLabel}</strong></div><div><span className="label">Base</span><strong className="value">{review.baseBranch}</strong></div><div><span className="label">Diff</span><strong><span className="add">+{additions}</span> <span className="del">−{deletions}</span></strong></div><div><span className="label">Status</span><strong>{review.status}</strong></div><div><span className="label">Mergeability</span><strong>{review.pullRequest?.mergeable == null ? "unknown" : review.pullRequest.mergeable ? review.pullRequest.mergeableState ?? "mergeable" : "blocked"}</strong></div><div><span className="label">GitHub checks</span><strong>{review.githubChecksPassing == null ? "not synchronized" : review.githubChecksPassing ? "passing" : "blocked"}</strong></div></div>{owner && !isMerged && !isAbandoned && <div className="review-actions">{review.pullRequest && <button type="button" className="button" disabled={busy} onClick={() => void onReady()}>{review.status === "draft" ? "Ready for review" : "Refresh GitHub status"}</button>}{review.pullRequest && <button type="button" className="button primary-button" disabled={busy || !canMerge} title={canMerge ? "Squash merge through GitHub" : review.integrationRunId ? "The candidate is still being updated" : "The PR must be ready, mergeable, and passing checks"} onClick={() => setMergeConfirmOpen(true)}>Squash merge</button>}<button type="button" className="button danger-button" disabled={busy} title={review.integrationRunId ? "The candidate is still being updated" : "Retire this candidate without merging"} onClick={() => setAbandonConfirmOpen(true)}>Abandon candidate</button></div>}</header>
    <div className="review-grid">{filesPane}{centerPane}
      <aside className="review-side"><ConflictCases conflicts={review.conflicts} selectedCaseId={selectedConflictCaseId} owner={owner} currentUserId={currentUserId} busy={busy} onResolve={onResolveConflict} onAnswer={onAnswerConflict} /><section className="review-pane" aria-label="Integration warnings"><div className="review-pane-head"><h3>Integration</h3><span>{review.warnings.length}</span></div>{review.warnings.length === 0 ? <p className="review-empty">No integration warnings.</p> : <ul className="review-warning-list">{review.warnings.map((warning) => <li key={warning.id} data-severity={warning.severity}><strong>{warning.title}</strong><p>{warning.detail}</p></li>)}</ul>}</section><section className="review-pane" aria-label="Checks"><div className="review-pane-head"><h3>Checks</h3><span>{review.checks.length}</span></div>{review.checks.length === 0 ? <p className="review-empty">No checks reported by GitHub or openfloor.</p> : <ul className="review-check-list">{review.checks.map((check) => <li key={check.id}><span className="check-mark" aria-label={check.state}>{check.state === "passed" ? "✓" : check.state === "failed" ? "!" : "…"}</span><div><strong>{check.name}</strong>{check.detail && <span>{check.detail}</span>}</div></li>)}</ul>}</section>{(isMerged || isAbandoned) && <section className="review-pane" aria-label="Branch cleanup"><div className="review-pane-head"><h3>Branch cleanup</h3><span>{review.cleanupStatus ?? "pending"}</span></div><p className="review-empty">{isAbandoned && !review.cleanupStatus ? "This candidate was abandoned without attempting to delete its branch." : review.cleanupStatus === "complete" ? "Recorded candidate and run branches were deleted after exact-SHA verification." : "Any branch that did not match its recorded SHA was preserved."}</p>{owner && !review.branchDeletedAt && <div className="review-actions"><button type="button" className="button danger-button" disabled={busy || retrying} onClick={() => isMerged ? setDeleteConfirmOpen(true) : void runAbandon(true)}>Delete candidate branch</button></div>}</section>}{teamChatPane}</aside>
    </div>
    {mergeConfirmOpen && <MergeConfirmDialog busy={busy} onClose={() => setMergeConfirmOpen(false)} onConfirm={runMerge} />}
    {deleteConfirmOpen && <DeleteBranchConfirmDialog branch={review.branch} busy={busy} onClose={() => setDeleteConfirmOpen(false)} onConfirm={runDeleteBranch} />}
    {abandonConfirmOpen && <AbandonConfirmDialog branch={review.branch} busy={busy} onClose={() => setAbandonConfirmOpen(false)} onConfirm={runAbandon} />}
    {blockingRunId && pendingAction && <IntegrationBlockedDialog retrying={retrying} onClose={() => setPendingAction(null)} onConfirm={cancelBlockingRunAndRetry} />}
  </section>;
}

function ConflictCases({ conflicts, selectedCaseId, owner, currentUserId, busy, onResolve, onAnswer }: {
  conflicts: MergeConflictCase[];
  selectedCaseId: string | null;
  owner: boolean;
  currentUserId: string;
  busy: boolean;
  onResolve: (caseId: string) => Promise<boolean>;
  onAnswer: (caseId: string, answers: Array<{ questionId: string; answer: string }>) => Promise<boolean>;
}) {
  if (conflicts.length === 0) return null;
  const ordered = [...conflicts].sort((a, b) => Number(b.id === selectedCaseId) - Number(a.id === selectedCaseId) || b.updatedAt - a.updatedAt);
  return <section className="review-pane conflict-cases" aria-label="Merge conflicts"><div className="review-pane-head"><h3>Merge conflicts</h3><span>{conflicts.length}</span></div><ul className="conflict-case-list">{ordered.map((conflict) => <ConflictCaseCard key={conflict.id} conflict={conflict} selected={conflict.id === selectedCaseId} owner={owner} canAnswer={owner || conflict.prompts.some((prompt) => prompt.authorUserId === currentUserId)} busy={busy} onResolve={onResolve} onAnswer={onAnswer} />)}</ul></section>;
}

function ConflictCaseCard({ conflict, selected, owner, canAnswer, busy, onResolve, onAnswer }: {
  conflict: MergeConflictCase;
  selected: boolean;
  owner: boolean;
  canAnswer: boolean;
  busy: boolean;
  onResolve: (caseId: string) => Promise<boolean>;
  onAnswer: (caseId: string, answers: Array<{ questionId: string; answer: string }>) => Promise<boolean>;
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
  return <li className="conflict-case" data-selected={selected ? "true" : undefined} data-status={conflict.status}>
    <div className="conflict-case-head"><strong>Merge Resolver</strong><span className="queue-chip" data-kind="status" data-status={conflict.status}>{conflict.status.replace("_", " ")}</span></div>
    <p>{conflict.explanation ?? conflict.conflictReason}</p>
    <dl><div><dt>Source</dt><dd>{conflict.agentName} · run {conflict.sourceRunId.slice(0, 8)}</dd></div><div><dt>Attempts</dt><dd>{conflict.automaticAttempts}/2 automatic attempts since last answer</dd></div></dl>
    {conflict.prompts.length > 0 && <><span className="label">Original intent</span><ul className="conflict-answer-audit">{conflict.prompts.map((prompt) => <li key={prompt.id}><strong>{prompt.authorName}</strong><p>{prompt.text}</p></li>)}</ul></>}
    {conflict.conflictPaths.length > 0 && <><span className="label">Affected paths</span><ul className="conflict-paths">{conflict.conflictPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></>}
    {conflict.attempts.length > 0 && <><span className="label">Resolver attempts</span><ul className="conflict-answer-audit">{conflict.attempts.map((attempt, index) => <li key={attempt.runId}><strong>Attempt {index + 1} · {attempt.launchKind} · {attempt.status.replace("_", " ")}</strong>{attempt.summary && <p>{attempt.summary}</p>}{attempt.checks.map((check) => <small key={check.command}>{check.status} · <code>{check.command}</code></small>)}</li>)}</ul></>}
    {conflict.questions.some((question) => question.answer !== null) && <ul className="conflict-answer-audit">{conflict.questions.filter((question) => question.answer !== null).map((question) => <li key={question.id}><strong>{question.question}</strong><p>{question.answer}</p><small>Answered by {question.answeredByName ?? "former member"}{question.answeredAt && <> · <LocalDateTime timestamp={question.answeredAt} /></>}</small></li>)}</ul>}
    {conflict.status === "awaiting_input" && unanswered.length > 0 && canAnswer && <form className="conflict-answer-form" onSubmit={submitAnswers}>{unanswered.map((question) => <label key={question.id}><span>{question.question}</span><textarea required maxLength={2000} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /></label>)}<button type="submit" className="button primary-button" disabled={busy || submitting || !canSubmit}>Submit answers</button><small>First complete submission wins. Team chat remains available for discussion.</small></form>}
    {conflict.status === "awaiting_input" && unanswered.length > 0 && !canAnswer && <p className="review-empty">Waiting for the session owner or an original prompt author to answer. Team chat remains available for discussion.</p>}
    {owner && (conflict.status === "failed" || conflict.status === "pending") && <button type="button" className="button" disabled={busy} onClick={() => void onResolve(conflict.id)}>{conflict.status === "failed" ? "Retry Merge Resolver" : "Start Merge Resolver"}</button>}
    {conflict.failureReason && <p className="objective-error">{conflict.failureReason}</p>}
  </li>;
}

type TreeNode = { name: string; path: string; type: "file" | "dir"; children?: TreeNode[] };

/** Groups the flat entry list the tree API returns into a nested structure for disclosure
    rendering, derived purely from file paths so it doesn't depend on GitHub also emitting an
    explicit "dir" entry for every ancestor. */
function buildFileTree(entries: RepositoryTreeEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirIndex = new Map<string, TreeNode>();
  function ensureDir(path: string): TreeNode[] {
    if (path === "") return root;
    const existing = dirIndex.get(path);
    if (existing) return existing.children!;
    const segments = path.split("/");
    const parentChildren = ensureDir(segments.slice(0, -1).join("/"));
    const node: TreeNode = { name: segments[segments.length - 1], path, type: "dir", children: [] };
    dirIndex.set(path, node);
    parentChildren.push(node);
    return node.children!;
  }
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const segments = entry.path.split("/");
    const parentChildren = ensureDir(segments.slice(0, -1).join("/"));
    parentChildren.push({ name: segments[segments.length - 1], path: entry.path, type: "file" });
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    for (const node of nodes) if (node.children) sortNodes(node.children);
  };
  sortNodes(root);
  return root;
}

function RepositoryTreeBranch({ nodes, depth, expandedDirs, onToggleDir, selectedPath, onSelectFile }: {
  nodes: TreeNode[];
  depth: number;
  expandedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}) {
  return <ul className="review-tree-list" role="group">
    {nodes.map((node) => node.type === "dir" ? (
      <li key={node.path} role="treeitem" aria-expanded={expandedDirs.has(node.path)} aria-selected="false">
        <button type="button" className="review-tree-dir" style={{ paddingLeft: `${depth * 14 + 8}px` }} onClick={() => onToggleDir(node.path)}>
          <Icon name={expandedDirs.has(node.path) ? "chevronDown" : "chevronRight"} size={12} />
          <span>{node.name}</span>
        </button>
        {expandedDirs.has(node.path) && node.children && <RepositoryTreeBranch nodes={node.children} depth={depth + 1} expandedDirs={expandedDirs} onToggleDir={onToggleDir} selectedPath={selectedPath} onSelectFile={onSelectFile} />}
      </li>
    ) : (
      <li key={node.path} role="treeitem" aria-selected={selectedPath === node.path ? "true" : "false"}>
        <button type="button" className="review-tree-file" data-selected={selectedPath === node.path ? "true" : "false"} style={{ paddingLeft: `${depth * 14 + 8}px` }} onClick={() => onSelectFile(node.path)}>
          <Icon name="file" size={12} />
          <span>{node.name}</span>
        </button>
      </li>
    ))}
  </ul>;
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

function AbandonConfirmDialog({ branch, busy, onClose, onConfirm }: { branch: string; busy: boolean; onClose: () => void; onConfirm: (deleteBranch: boolean) => Promise<void> }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="abandon-confirm-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="abandon-confirm-title">Abandon “{branch}”?</h2><p>This retires the candidate without merging so a new one can be created. Decide what happens to the branch itself — this cannot be undone.</p></div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={() => void onConfirm(false)} disabled={busy}>Abandon, keep branch</button>
        <button type="button" className="button danger-button" onClick={() => void onConfirm(true)} disabled={busy}>Abandon, delete branch</button>
      </div>
    </dialog>
  );
}

function IntegrationBlockedDialog({ retrying, onClose, onConfirm }: { retrying: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="integration-blocked-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="integration-blocked-title">The candidate is still updating</h2><p>A run is integrating or being rolled back, so this action is blocked until the candidate update finishes.</p></div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={retrying}>Wait</button>
        <button type="button" className="button danger-button" onClick={() => void onConfirm()} disabled={retrying}>{retrying ? "Cancelling…" : "Cancel that run & retry"}</button>
      </div>
    </dialog>
  );
}

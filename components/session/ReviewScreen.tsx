"use client";

import { RunAttributionInfo } from "./RunAttributionInfo";
import { memo, useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, Fragment } from "react";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { FloorMessage, FloorParticipant, FloorReviewSnapshot, RepositoryPreviewSnapshot, ReviewContribution, ReviewContributor, ReviewContributorFacet, SessionFile } from "@/lib/floor-types";
import type { RepositoryTreeEntry } from "@/lib/github";
import type { RepositoryConnection } from "@/lib/session-types";
import { agentTone } from "./data";
import { HoverTip, Icon, PersonName, SegmentedControl, useDialogDismiss, useHoverTip } from "./primitives";
import { Markdown } from "./Markdown";
import { TeamChat } from "./TeamChat";
import type { RollbackIntent } from "./RollbackImpactDialog";
import { SessionPromptDetail, SessionPromptRail, useSessionPromptHistory } from "./SessionPromptHistory";
import { useReviewContributionDetail, useReviewContributions } from "./useReviewContributions";
import type { RepositorySource } from "./useRepositoryTree";
import { ConflictCenterDialog } from "./ConflictCenterDialog";
import type { ConflictMutation } from "@/lib/conflict-resolution";

type PendingAction = { type: "merge"; deleteCandidateBranch: boolean } | { type: "deleteBranch" } | { type: "abandon"; deleteBranch: boolean };
type Selection = { kind: "changed"; id: string } | { kind: "repo"; path: string };
type Browse = "changed" | "all" | "prompts" | "preview";
type InspectorTab = "status" | "chat" | "contributors";
type MergeReadiness = "ready" | "waiting" | "blocked" | "locked";
const DISCONNECTED_STATUSES = new Set(["disconnected", "revoked", "inaccessible"]);
const REVIEW_RAIL_MIN = 250;
const REVIEW_RAIL_MAX = 560;

function mergeBlockers(review: FloorReviewSnapshot | null): string[] {
  if (!review) return ["No review available"];
  const pr = review.pullRequest;
  const blockers: string[] = [];
  if (review.mergeLockedAt) blockers.push("Locked by the session owner");
  if (!pr) blockers.push("Waiting for a pull request");
  if (review.status === "draft") blockers.push("Mark the pull request ready");
  if (pr && pr.state !== "open") blockers.push("Pull request is closed");
  if (pr?.mergeable == null) blockers.push("GitHub is calculating mergeability");
  else if (!pr.mergeable) blockers.push("GitHub reports this pull request is not mergeable");
  else if (pr.mergeableState !== "clean") blockers.push(`GitHub merge requirements: ${pr.mergeableState ?? "not ready"}`);
  if (review.githubChecksPassing == null) blockers.push("GitHub checks are not synchronized");
  else if (!review.githubChecksPassing) blockers.push("GitHub checks are not passing");
  if (review.integrationRunId) blockers.push("Candidate update is in progress");
  return blockers;
}

function mergeReadiness(review: FloorReviewSnapshot | null, blockers: string[]): MergeReadiness {
  if (!review) return "waiting";
  if (review.mergeLockedAt) return "locked";
  if (blockers.length === 0) return "ready";
  if (review.pullRequest?.mergeable == null || review.githubChecksPassing == null || review.integrationRunId) return "waiting";
  return "blocked";
}

export const ReviewScreen = memo(function ReviewScreen({ sessionId, revision, review, preview, previewEnabled, repository, repositoryTree, selectedConflictCaseId, promptRequest, owner, busy, blockingRunId, onStartPreview, onStopPreview, onRequestRollback, onSync, onReady, onUnready, onMerge, onMergeLock, onDeleteBranch, onAbandon, onCancelRun, onConflictMutation, teamChat, onSendTeamMessage, participants, currentUserId, sessionFiles }: {
  sessionId: string;
  revision: number;
  review: FloorReviewSnapshot | null;
  preview: RepositoryPreviewSnapshot | null;
  previewEnabled: boolean;
  repository: RepositoryConnection | null;
  repositoryTree: RepositorySource;
  selectedConflictCaseId: string | null;
  promptRequest: { runId: string; status: "active" | "rolled_back" } | null;
  owner: boolean;
  busy: boolean;
  blockingRunId: string | null;
  onStartPreview: () => Promise<boolean>;
  onStopPreview: () => Promise<boolean>;
  onRequestRollback: (intent: RollbackIntent) => void;
  onSync: (options?: { silent?: boolean }) => Promise<boolean>;
  onReady: () => Promise<void>;
  onUnready: () => Promise<void>;
  onMerge: (deleteCandidateBranch: boolean) => Promise<boolean>;
  onMergeLock: (locked: boolean) => Promise<void>;
  onDeleteBranch: () => Promise<boolean>;
  onAbandon: (deleteBranch: boolean) => Promise<boolean>;
  onCancelRun: (runId: string) => Promise<void>;
  onConflictMutation: ConflictMutation;
  teamChat: FloorMessage[];
  sessionFiles: SessionFile[];
  onSendTeamMessage: (text: string, recipientUserId: string | null) => Promise<boolean>;
  participants: FloorParticipant[];
  currentUserId: string;
}) {
  const files = useMemo(() => review?.files ?? [], [review]);
  const checks = review?.checks ?? [];
  const warnings = review?.warnings ?? [];
  const conflicts = review?.conflicts ?? [];
  const [allPrompts, setAllPrompts] = useState(!promptRequest);
  const repositoryBrowsable = repository != null && !DISCONNECTED_STATUSES.has(repository.status);
  // ReviewScreen fully unmounts whenever Workspace switches back to
  // "workspace" (see the screen === "review" ? ... conditional there), so
  // these seed straight from an incoming promptRequest rather than only
  // reacting to it after mount.
  const [browseOverride, setBrowseOverride] = useState<Browse | null>(promptRequest ? "prompts" : null);
  const [rightTabOverride, setRightTabOverride] = useState<InspectorTab | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [contributionStatus, setContributionStatus] = useState<"active" | "rolled_back">(promptRequest?.status ?? "active");
  const [engineerFilter, setEngineerFilter] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [selectedPromptRunId, setSelectedPromptRunId] = useState<string | null>(promptRequest?.runId ?? null);
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [abandonConfirmOpen, setAbandonConfirmOpen] = useState(false);
  const [readyConfirmOpen, setReadyConfirmOpen] = useState(false);
  const [unreadyConfirmOpen, setUnreadyConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  // The conflict center opens deep-linked when Workspace hands us a case id
  // (attention banner, agent card, notification click), or unlinked (case
  // rail inside the dialog picks) when the hero Conflicts button is clicked.
  const [conflictCenter, setConflictCenter] = useState<{ caseId: string | null } | null>(selectedConflictCaseId ? { caseId: selectedConflictCaseId } : null);
  const [handledConflictCaseId, setHandledConflictCaseId] = useState(selectedConflictCaseId);
  // Files / inspector column widths — same drag pattern as the workspace
  // rails. The inspector defaults wider: status/checks/chat need the room.
  const [reviewWidths, setReviewWidths] = useState({ files: 280, inspector: 400 });
  const [resizing, setResizing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [handledPromptRequest, setHandledPromptRequest] = useState(promptRequest);
  const branchTip = useHoverTip();
  const conflictTip = useHoverTip();
  const refreshTip = useHoverTip();
  const lockTip = useHoverTip();
  const mergeTip = useHoverTip();
  const filePathTip = useHoverTip();

  // Auto-refresh the review pull request state from GitHub when mounting the review screen
  // if an active PR exists (ENG-review-auto-sync).
  const prNumber = review?.pullRequest?.number;
  const reviewStatus = review?.status;
  useEffect(() => {
    if (prNumber && reviewStatus !== "merged" && reviewStatus !== "abandoned") {
      void onSync({ silent: true });
    }
  }, [onSync, prNumber, reviewStatus]);

  // A click from the queue passes a fresh promptRequest object each time —
  // jump into Prompts mode for it even if the viewer had switched away, but
  // only once per request so their own subsequent clicks around the screen
  // aren't fought (React's documented "adjust state during render" pattern).
  if (promptRequest !== handledPromptRequest) {
    setHandledPromptRequest(promptRequest);
    if (promptRequest) {
      setBrowseOverride("prompts");
      setContributionStatus(promptRequest.status);
      setAllPrompts(false);
      setSelectedPromptRunId(promptRequest.runId);
    }
  }

  // A fresh case id from Workspace (banner/agent-card/notification click)
  // deep-links the center onto that case once — dismissing the dialog leaves
  // it closed until a *different* case id arrives (same adjust-during-render
  // pattern as promptRequest above).
  if (selectedConflictCaseId !== handledConflictCaseId) {
    setHandledConflictCaseId(selectedConflictCaseId);
    if (selectedConflictCaseId) setConflictCenter({ caseId: selectedConflictCaseId });
  }

  const hasChangedFiles = Boolean(review && files.length > 0);
  const openConflicts = review?.conflicts.filter((conflict) => conflict.status !== "resolved") ?? [];
  const conflictAttention: "action" | "working" | undefined = openConflicts.some((conflict) => conflict.status === "awaiting_input" || conflict.status === "failed")
    ? "action"
    : openConflicts.length > 0
      ? "working"
      : undefined;

  function startReviewResize(side: "files" | "inspector", event: ReactPointerEvent<HTMLDivElement>) {
    const direction = side === "files" ? 1 : -1;
    const startX = event.clientX;
    const startWidth = reviewWidths[side];
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => setReviewWidths((current) => ({ ...current, [side]: Math.max(REVIEW_RAIL_MIN, Math.min(REVIEW_RAIL_MAX, startWidth + direction * (moveEvent.clientX - startX))) }));
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const reviewGridStyle = { "--review-files-w": `${reviewWidths.files}px`, "--review-inspector-w": `${reviewWidths.inspector}px` } as CSSProperties;
  const reviewResizeHandles = <>
    <div className="resize-handle review-resize-handle" data-side="files" role="separator" aria-orientation="vertical" aria-label="Resize files panel" onPointerDown={(event) => startReviewResize("files", event)} />
    <div className="resize-handle review-resize-handle" data-side="inspector" role="separator" aria-orientation="vertical" aria-label="Resize inspector panel" onPointerDown={(event) => startReviewResize("inspector", event)} />
  </>;
  // One "Browse" control replaces the old independent Changed/All and
  // Files/Prompts toggles. Prompts is only ever reached by an explicit click
  // (via this override, or the "View prompt changes" shortcut below) — it's
  // never a default, same as the old `mode` state.
  const browse: Browse = browseOverride ?? (hasChangedFiles ? "changed" : "all");
  const activeTab: "changed" | "all" = browse === "prompts" || browse === "preview" ? (hasChangedFiles ? "changed" : "all") : browse;
  // The Contributors tab only exists while browsing Prompts; if it's active
  // and Browse switches away, this falls back to Status on its own — no
  // effect needed, same self-healing idiom as `selected` below.
  const availableRightTabs: InspectorTab[] = browse === "prompts" ? ["status", "chat", "contributors"] : ["status", "chat"];
  const rightTab: InspectorTab = rightTabOverride && availableRightTabs.includes(rightTabOverride) ? rightTabOverride : "status";
  const fileTree = useMemo(() => repositoryTree.tree ? buildFileTree(repositoryTree.tree.entries) : [], [repositoryTree.tree]);

  // Fires once per candidate head: the hook's own idempotency guard (and the
  // reset it gets on a "repository" floor-domain push) make repeated calls a
  // no-op, so this doesn't need a tighter dependency list.
  useEffect(() => {
    if (browse !== "preview" && repositoryBrowsable && repositoryTree.treeState === "idle") repositoryTree.load();
  }, [browse, repositoryBrowsable, repositoryTree]);

  // Self-heals like the pre-tree version did: falls back to the first changed
  // file whenever the current selection stops existing (a new run, a merge),
  // but leaves a repo-path selection alone since the tree doesn't move.
  const selected = useMemo<Selection | null>(() => {
    if (selection?.kind === "changed" && review?.files.some((file) => file.id === selection.id)) return selection;
    if (selection?.kind === "repo") return selection;
    if (review && files.length > 0) return { kind: "changed", id: files[0].id };
    return null;
  }, [selection, review, files]);

  const selectedChangedFile = selected?.kind === "changed" ? review?.files.find((file) => file.id === selected.id) ?? null : null;
  const selectedRepoPath = selected?.kind === "repo" ? selected.path : null;
  const selectedRepoFile = selectedRepoPath ? repositoryTree.fileFor(selectedRepoPath) : null;
  const selectedRepoFileState = selectedRepoPath ? repositoryTree.fileStateFor(selectedRepoPath) : "idle";
  const fileContributions = useReviewContributions(sessionId, revision, {
    status: "active",
    path: selectedChangedFile?.path,
    enabled: browse !== "prompts" && browse !== "preview" && Boolean(selectedChangedFile),
  });
  const promptContributions = useReviewContributions(sessionId, revision, {
    status: contributionStatus,
    engineerId: engineerFilter,
    agentId: agentFilter,
    enabled: browse === "prompts" && !allPrompts && Boolean(review),
  });
  const sessionPrompts = useSessionPromptHistory(sessionId, revision, browse === "prompts" && allPrompts, engineerFilter, agentFilter);
  const effectivePromptRunId = selectedPromptRunId && promptContributions.items.some((item) => item.runId === selectedPromptRunId)
    ? selectedPromptRunId
    : promptContributions.items[0]?.runId ?? null;
  const promptDetail = useReviewContributionDetail(sessionId, revision, browse === "prompts" ? effectivePromptRunId : null);

  function selectChanged(id: string) {
    setBrowseOverride("changed");
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

  async function runReady() {
    setReadyConfirmOpen(false);
    await onReady();
  }

  async function runUnready() {
    setUnreadyConfirmOpen(false);
    await onUnready();
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

  // Shared by the no-review branches' plain Changed/All pane below and the
  // full-review left rail's 3-way Browse control — the list content itself
  // doesn't depend on how many options the toggle above it offers.
  const fileBrowseBody = activeTab === "changed" ? (
    files.length === 0 ? <p className="review-empty">No changed files.</p> : <ul className="review-file-list">{files.map((file) => <li key={file.id}><button type="button" className="review-file" data-selected={selectedChangedFile?.id === file.id ? "true" : "false"} onClick={() => selectChanged(file.id)}><span className="file-copy" title={file.path}><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span><FileAttribution contributors={file.contributors} /></span><span className="diff-stat"><i className="add">+{file.additions}</i><i className="del">−{file.deletions}</i></span></button></li>)}</ul>
  ) : (
    !repositoryBrowsable ? <p className="review-empty">No repository connected.</p> : repositoryTree.treeState === "loading" || repositoryTree.treeState === "idle" ? <p className="review-empty">Loading repository files…</p>
      : repositoryTree.treeState === "error" ? <p className="review-empty">The repository tree could not be loaded.</p>
      : fileTree.length === 0 ? <p className="review-empty">This repository has no files.</p>
      : <div className="review-tree" role="tree" aria-label="Repository files">
          <RepositoryTreeBranch nodes={fileTree} depth={0} expandedDirs={expandedDirs} onToggleDir={toggleDir} selectedPath={selectedRepoPath} onSelectFile={selectRepoPath} />
          {repositoryTree.tree?.truncated && <p className="review-empty">Showing a partial file list — this repository is very large.</p>}
        </div>
  );

  const previewOption = previewEnabled ? [{ value: "preview" as const, label: "Preview" }] : [];
  const centerPane = selectedChangedFile ? (
    <section className="review-pane review-diff" aria-label="Diff preview"><div className="review-pane-head"><h3 tabIndex={0} aria-label={selectedChangedFile.path} {...filePathTip.handlers}>{selectedChangedFile.path.split("/").pop()}</h3><FileAttribution contributors={selectedChangedFile.contributors} expanded /><HoverTip position={filePathTip.position}>{selectedChangedFile.path}</HoverTip></div><ContributionCards source={fileContributions} onOpen={(runId) => { setSelectedPromptRunId(runId); setContributionStatus("active"); setBrowseOverride("prompts"); }} onRollback={(runId) => onRequestRollback({ scope: "prompt", subjectId: runId })} />{selectedChangedFile.summary && <Markdown className="review-summary">{selectedChangedFile.summary}</Markdown>}{selectedChangedFile.diff.length > 0 ? <pre className="review-code" aria-label={`Diff preview for ${selectedChangedFile.path}`}>{selectedChangedFile.diff.map((line, index) => <span key={`${index}-${line.text}`} className="review-line" data-type={line.type}><i>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</i><code>{line.text}</code></span>)}</pre> : <p className="review-empty">No diff preview available.</p>}</section>
  ) : selectedRepoPath ? (
    <section className="review-pane review-diff review-file-pane" aria-label="File preview"><div className="review-pane-head"><h3>{selectedRepoPath}</h3></div>{
      selectedRepoFileState === "idle" || selectedRepoFileState === "loading" ? <p className="review-empty">Loading file…</p>
        : selectedRepoFileState === "error" ? <p className="review-empty">This file could not be loaded.</p>
        : selectedRepoFile?.encoding === "text" ? <>{selectedRepoFile.truncated && <p className="review-summary">Showing the first {selectedRepoFile.text.split("\n").length.toLocaleString()} lines.</p>}<pre className="review-code" aria-label={`File preview for ${selectedRepoPath}`}>{selectedRepoFile.text.split("\n").map((text, index) => <span key={index} className="review-line" data-type="context"><i> </i><code>{text}</code></span>)}</pre></>
        : selectedRepoFile?.encoding === "too_large" ? <p className="review-empty">This file is too large to preview?.</p>
        : <p className="review-empty">This file is binary and can’t be previewed.</p>
    }</section>
  ) : (
    <section className="review-pane review-diff" aria-label="Diff preview"><div className="review-pane-head"><h3>Diff preview</h3></div><div className="review-empty-state"><Icon name="branch" size={22} /><h2>No review available</h2><p>Select a file or prompt to inspect its changes.</p></div></section>
  );

  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const blockers = mergeBlockers(review);
  const canMerge = blockers.length === 0;
  const readiness = mergeReadiness(review, blockers);
  const mergeTipText = canMerge ? `Ready to squash merge into ${review?.baseBranch}` : blockers.join("\n");
  const conflictTipText = openConflicts.length === 0
    ? "No open conflicts"
    : conflictAttention === "action"
      ? `${openConflicts.length} conflict${openConflicts.length === 1 ? "" : "s"} need input`
      : `${openConflicts.length} conflict${openConflicts.length === 1 ? "" : "s"} being resolved`;
  const isMerged = review?.status === "merged";
  const isAbandoned = review?.status === "abandoned";

  // Browsing prompts swaps the left rail's list and the center pane for
  // prompt-attribution equivalents; the right rail (Status/Chat, plus
  // Contributors while browsing prompts) stays mounted either way — the bug
  // this fixes is that switching to Prompts used to replace the whole grid,
  // taking conflicts/checks/chat with it.
  const leftPane = <aside className="review-pane" aria-label={browse === "prompts" ? "Prompt groups" : browse === "preview" ? "App preview status" : "Repository files"}>
    <div className="review-pane-head"><SegmentedControl label="Browse" value={browse} onChange={setBrowseOverride} options={[{ value: "changed", label: `Changed (${files.length})` }, { value: "all", label: "All files" }, { value: "prompts", label: "Prompts" }, ...previewOption]} /></div>
    {browse === "preview" ? <PreviewLifecycle preview={preview} owner={owner} busy={busy} onStart={onStartPreview} onStop={onStopPreview} /> : browse === "prompts" ? <>
      <div className="review-pane-head"><SegmentedControl label="Prompt status" value={allPrompts ? "all" : contributionStatus} onChange={(value) => { setAllPrompts(value === "all"); if (value !== "all") setContributionStatus(value); }} options={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "rolled_back", label: "History" }]} /></div>
      {(engineerFilter || agentFilter) && <div className="review-filter-summary"><span>Filtered contributions</span><button type="button" className="button" data-size="sm" onClick={() => { setEngineerFilter(null); setAgentFilter(null); }}>Clear</button></div>}
      {allPrompts ? <SessionPromptRail history={sessionPrompts} /> : promptContributions.loading && promptContributions.items.length === 0 ? <p className="review-empty">Loading prompts…</p>
        : promptContributions.error ? <p className="review-empty" role="alert">{promptContributions.error}</p>
        : promptContributions.items.length === 0 ? <p className="review-empty">{contributionStatus === "active" ? "No active prompt changes match these filters." : "No rolled-back prompt groups match these filters."}</p>
        : <ul className="review-prompt-list">{promptContributions.items.map((contribution) => <li key={contribution.runId}><button type="button" className="review-prompt-item" data-selected={effectivePromptRunId === contribution.runId ? "true" : "false"} onClick={() => setSelectedPromptRunId(contribution.runId)}><strong>{contribution.prompts.length === 1 ? contribution.prompts[0].authorName : `${contribution.prompts.length} merged prompts`}</strong><span className="review-prompt-preview">{contributionPreview(contribution)}</span><small>{contribution.agentName} · {contribution.files.length} file{contribution.files.length === 1 ? "" : "s"} · {contributionLabel(contribution)}</small></button></li>)}</ul>}
      {!allPrompts && promptContributions.nextCursor && <div className="review-load-more"><button type="button" className="button" disabled={promptContributions.loading} onClick={() => void promptContributions.loadMore()}>{promptContributions.loading ? "Loading…" : "Load more"}</button></div>}
    </> : fileBrowseBody}
  </aside>;

  const mainCenterPane = browse === "preview" ? <PreviewBrowser preview={preview} /> : browse === "prompts"
    ? allPrompts ? <SessionPromptDetail sessionId={sessionId} promptId={sessionPrompts.selectedId} revision={revision} /> : <PromptContributionDetail detail={promptDetail} status={contributionStatus} onRollback={onRequestRollback} />
    : centerPane;

  const inspectorTabs: Array<{ value: InspectorTab; label: string }> = [
    { value: "status", label: "Checks" },
    { value: "chat", label: "Chat" },
    ...(browse === "prompts" ? [{ value: "contributors" as InspectorTab, label: "Contributors" }] : []),
  ];

  const rightPane = <div className="review-pane review-inspector" aria-label="Review panel">
    <div className="review-pane-head"><SegmentedControl label="Panel" value={rightTab} onChange={setRightTabOverride} options={inspectorTabs} /></div>
    <div className="review-inspector-body" data-tab={rightTab}>
      {rightTab === "status" && <>
        {warnings.length === 0 && checks.length === 0
          ? <p className="review-empty review-status-empty"><Icon name="check" size={14} />No checks available</p>
          : <>
              {warnings.length > 0 && <section aria-label="Integration warnings"><div className="review-pane-head"><h3>Issues</h3><span>{warnings.length}</span></div><ul className="review-warning-list">{warnings.map((warning) => <li key={warning.id} data-severity={warning.severity}><strong>{warning.title}</strong><p>{warning.detail}</p></li>)}</ul></section>}
              {checks.length > 0 && <section aria-label="Checks"><div className="review-pane-head"><h3>Checks</h3><span>{checks.length}</span></div><ul className="review-check-list">{checks.map((check) => <li key={check.id}><span className="check-mark" aria-label={check.state}>{check.state === "passed" ? "✓" : check.state === "failed" ? "!" : "…"}</span><div><strong>{check.name}</strong>{check.detail && <span>{check.detail}</span>}</div></li>)}</ul></section>}
            </>}
        {(isMerged || isAbandoned) && <section aria-label="Branch cleanup"><div className="review-pane-head"><h3>Branch cleanup</h3><span>{review?.cleanupStatus ?? "pending"}</span></div><p className="review-empty">{isAbandoned && !review?.cleanupStatus ? "This candidate was abandoned without attempting to delete its branch." : review?.cleanupStatus === "complete" ? "Recorded candidate and run branches were deleted after exact-SHA verification." : "Any branch that did not match its recorded SHA was preserved."}</p>{owner && !review?.branchDeletedAt && <div className="review-actions"><button type="button" className="button danger-button" disabled={busy || retrying} onClick={() => isMerged ? setDeleteConfirmOpen(true) : void runAbandon(true)}>Delete candidate branch</button></div>}</section>}
      </>}
      {rightTab === "chat" && <div className="review-inspector-chat" aria-label="Team chat"><div className="review-pane-head"><h3>Team chat</h3><span>{teamChat.filter((message) => message.recipientUserId === null).length}</span></div><TeamChat messages={teamChat} onSend={onSendTeamMessage} participants={participants} currentUserId={currentUserId} sessionId={sessionId} files={sessionFiles} /></div>}
      {rightTab === "contributors" && (allPrompts ? <>
        <div className="review-pane-head"><h3>Engineers</h3></div>{sessionPrompts.engineers.map((person) => <button type="button" className="button" key={person.id} aria-pressed={engineerFilter === person.id} onClick={() => setEngineerFilter(engineerFilter === person.id ? null : person.id)}>{person.name}</button>)}
        <div className="review-pane-head"><h3>Agents</h3></div>{sessionPrompts.agents.map((agent) => <button type="button" className="button" key={agent.id} aria-pressed={agentFilter === agent.id} onClick={() => setAgentFilter(agentFilter === agent.id ? null : agent.id)}>{agent.name}</button>)}
      </> : <>
        <ContributorList title="Engineers" facets={promptContributions.engineers} selectedId={engineerFilter} owner={owner && contributionStatus === "active"} scope="engineer" onFilter={setEngineerFilter} onRollback={onRequestRollback} />
        <ContributorList title="Agents" facets={promptContributions.agents} selectedId={agentFilter} owner={owner && contributionStatus === "active"} scope="agent" onFilter={setAgentFilter} onRollback={onRequestRollback} />
      </>)}
    </div>
  </div>;

  return <section className="review-screen" aria-label="Review candidate" data-resizing={resizing ? "true" : "false"}>
    <header className="review-hero review-command-bar">
      <div className="review-candidate-context">
        <div className="review-branch-path" tabIndex={0} aria-label={review ? `${review.branch} into ${review.baseBranch}` : "No review candidate"} {...branchTip.handlers}>
          <Icon name="branch" size={16} />
          <strong>{review?.branch ?? "No review candidate"}</strong>
          <Icon name="arrowRight" size={13} className="review-branch-arrow" />
          <span>{review?.baseBranch}</span>
        </div>
        <div className="review-compact-meta">
          {review?.pullRequest && <a className="review-pr-link" href={review?.pullRequest.url} target="_blank" rel="noreferrer" aria-label={`${review?.pullRequest.draft ? "Draft " : ""}pull request ${review?.pullRequest.number} on GitHub`}>PR #{review?.pullRequest.number}<Icon name="external" size={12} /></a>}
          <span className="review-diff-stat" aria-label={`${additions} additions and ${deletions} deletions`}><i className="add">+{additions}</i><i className="del">−{deletions}</i></span>
        </div>
        <HoverTip position={branchTip.position} wrap>{review?.commitSha ? `Candidate SHA\n${review?.commitSha}` : "Candidate has not been committed"}</HoverTip>
      </div>
      <div className="review-actions review-command-actions">
        <button type="button" className="button conflicts-button" data-size="sm" data-attention={conflictAttention} onClick={() => setConflictCenter({ caseId: null })} {...conflictTip.handlers}>
          <Icon name={openConflicts.length > 0 ? "alert" : "check"} size={14} />
          Conflicts
          {openConflicts.length > 0 && <strong className="review-action-count">{openConflicts.length}</strong>}
        </button>
        {owner && !isMerged && !isAbandoned && <>
          {!review && <><button type="button" className="button" disabled title="No review candidate">Ready for review</button><button type="button" className="button" disabled title="No review candidate" aria-label="Refresh GitHub status"><Icon name="refresh" /></button><button type="button" className="button" disabled title="No review candidate" aria-label="Lock squash merge"><Icon name="lock" /></button><button type="button" className="button" disabled title="No review candidate">Squash merge</button></>}
          {review?.pullRequest && review?.status === "draft" && <button type="button" className="button" disabled={busy} onClick={() => setReadyConfirmOpen(true)}>Ready for review</button>}
          {review?.pullRequest && review?.status === "ready" && <button type="button" className="button" disabled={busy} onClick={() => setUnreadyConfirmOpen(true)}>Mark as not ready</button>}
          {review?.pullRequest && <button type="button" className="button review-icon-action" data-size="sm" disabled={busy} aria-label="Refresh GitHub status" onClick={() => void onSync()} {...refreshTip.handlers}><Icon name="refresh" size={15} /></button>}
          {review?.pullRequest && <button type="button" className="button review-icon-action" data-size="sm" disabled={busy} aria-label={review?.mergeLockedAt ? "Unlock squash merge" : "Lock squash merge"} aria-pressed={Boolean(review?.mergeLockedAt)} onClick={() => void onMergeLock(!review?.mergeLockedAt)} {...lockTip.handlers}><Icon name={review?.mergeLockedAt ? "lock" : "unlock"} size={15} /></button>}
          {review?.pullRequest && <>
            <button type="button" className="button primary-button review-merge-button" data-state={readiness} aria-disabled={busy || !canMerge} aria-describedby={`${sessionId}-merge-readiness`} onClick={() => { if (!busy && canMerge) setMergeConfirmOpen(true); }} {...mergeTip.handlers}>
              <Icon name={readiness === "ready" ? "check" : readiness === "locked" ? "lock" : readiness === "waiting" ? "clock" : "alert"} size={14} />
              Squash merge
            </button>
            <span id={`${sessionId}-merge-readiness`} className="sr-only">{mergeTipText}</span>
          </>}
          <button type="button" className="button danger-button" disabled={busy || !review} title={review?.integrationRunId ? "The candidate is still being updated" : "Retire this candidate without merging"} onClick={() => setAbandonConfirmOpen(true)}>Abandon candidate</button>
        </>}
      </div>
      <HoverTip position={conflictTip.position}>{conflictTipText}</HoverTip>
      <HoverTip position={refreshTip.position}>Refresh GitHub status</HoverTip>
      <HoverTip position={lockTip.position}>{review?.mergeLockedAt ? "Unlock squash merge" : "Lock squash merge"}</HoverTip>
      <HoverTip position={mergeTip.position} wrap>{mergeTipText}</HoverTip>
    </header>
    <div className="review-grid" style={reviewGridStyle}>{leftPane}{mainCenterPane}<aside className="review-side">{rightPane}</aside>{reviewResizeHandles}</div>
    {readyConfirmOpen && <ReadyConfirmDialog busy={busy} onClose={() => setReadyConfirmOpen(false)} onConfirm={runReady} />}
    {unreadyConfirmOpen && <UnreadyConfirmDialog busy={busy} onClose={() => setUnreadyConfirmOpen(false)} onConfirm={runUnready} />}
    {mergeConfirmOpen && <MergeConfirmDialog busy={busy} onClose={() => setMergeConfirmOpen(false)} onConfirm={runMerge} />}
    {review && deleteConfirmOpen && <DeleteBranchConfirmDialog branch={review?.branch} busy={busy} onClose={() => setDeleteConfirmOpen(false)} onConfirm={runDeleteBranch} />}
    {review && abandonConfirmOpen && <AbandonConfirmDialog branch={review?.branch} busy={busy} onClose={() => setAbandonConfirmOpen(false)} onConfirm={runAbandon} />}
    {blockingRunId && pendingAction && <IntegrationBlockedDialog retrying={retrying} onClose={() => setPendingAction(null)} onConfirm={cancelBlockingRunAndRetry} />}
    {conflictCenter && <ConflictCenterDialog sessionId={sessionId} conflicts={conflicts} initialCaseId={conflictCenter.caseId} owner={owner} currentUserId={currentUserId} busy={busy} onClose={() => setConflictCenter(null)} onMutation={onConflictMutation} />}
  </section>;
});

export function PreviewLifecycle({ preview, owner, busy, onStart, onStop }: {
  preview: RepositoryPreviewSnapshot | null;
  owner: boolean;
  busy: boolean;
  onStart: () => Promise<boolean>;
  onStop: () => Promise<boolean>;
}) {
  const stale = Boolean(preview?.activeCandidateSha && preview.activeCandidateSha !== preview.targetCandidateSha);
  const running = preview?.status === "provisioning";
  return <div className="review-preview-lifecycle-body">
    <div className="review-pane-head"><h3>App preview</h3><span>{preview?.status ?? "stopped"}</span></div>
    {!preview ? <p className="review-empty">No shared preview is running. Root JavaScript apps with one frozen lockfile and a dev or start script are supported.</p> : <dl className="review-preview-facts">
      <div><dt>Status</dt><dd>{running && preview.url ? "rebuilding" : preview.status}</dd></div>
      {preview.packageManager && <div><dt>Runtime</dt><dd>{preview.packageManager} · {preview.script}</dd></div>}
      <div><dt>Candidate</dt><dd title={preview.targetCandidateSha}>{preview.targetCandidateSha.slice(0, 8)}</dd></div>
      {preview.activeCandidateSha && <div><dt>Visible</dt><dd title={preview.activeCandidateSha}>{preview.activeCandidateSha.slice(0, 8)}{stale ? " · stale" : " · current"}</dd></div>}
      <div><dt>Expires</dt><dd><LocalDateTime timestamp={preview.expiresAt} /></dd></div>
    </dl>}
    {preview?.failureReason && <p className="review-preview-failure" role="alert">{preview.failureReason}</p>}
    {owner && <div className="review-actions">
      <button type="button" className="button primary-button" disabled={busy || running} onClick={() => void onStart()}>{preview?.url ? "Rebuild preview" : "Start preview"}</button>
      {preview && <button type="button" className="button danger-button" disabled={busy} onClick={() => void onStop()}>Stop preview</button>}
    </div>}
    {!owner && !preview && <p className="review-empty">Session owner can start preview.</p>}
  </div>;
}

export function PreviewBrowser({ preview }: { preview: RepositoryPreviewSnapshot | null }) {
  const [reload, setReload] = useState(0);
  const url = preview?.url;
  if (!url) return <section className="review-pane review-preview-browser" aria-label="App preview">
    <div className="review-empty-state"><Icon name="external" size={22} /><h2>{preview?.status === "provisioning" ? "Building preview" : preview?.status === "failed" ? "Preview build failed" : preview?.status === "expired" ? "Preview expired" : "No app preview"}</h2><p>{preview?.status === "provisioning" ? "Installing dependencies and detecting one HTTP listener." : "Start a preview to interact with the candidate app here."}</p></div>
  </section>;
  return <section className="review-pane review-preview-browser" aria-label="Interactive app preview">
    <div className="review-preview-chrome">
      <span className="review-preview-dots" aria-hidden="true"><i /><i /><i /></span>
      <input aria-label="Preview URL" value={url} readOnly />
      <button type="button" className="button" data-size="sm" onClick={() => setReload((value) => value + 1)}>Reload</button>
      <a className="button" data-size="sm" href={url} target="_blank" rel="noreferrer">Open in new tab</a>
    </div>
    {preview.status === "provisioning" && <p className="review-preview-notice" role="status">Rebuilding latest candidate. Prior preview remains interactive.</p>}
    {preview.activeCandidateSha !== preview.targetCandidateSha && <p className="review-preview-notice" role="status">Showing prior candidate while latest build is unavailable.</p>}
    <iframe key={`${url}-${reload}`} title="Interactive candidate app preview" src={url} sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts" />
  </section>;
}

type ContributionSource = ReturnType<typeof useReviewContributions>;
type ContributionDetailSource = ReturnType<typeof useReviewContributionDetail>;

function contributionLabel(contribution: ReviewContribution) {
  if (contribution.rollbackStatus === "completed") return "Rolled back";
  if (contribution.rollbackStatus === "requested" || contribution.rollbackStatus === "running") return "Rolling back";
  if (contribution.rollbackStatus === "failed") return "Rollback failed";
  return "Active";
}

function contributionPreview(contribution: ReviewContribution) {
  return contribution.prompts.map((prompt) => prompt.text).join(" · ");
}

function EngineerNames({ contribution }: { contribution: ReviewContribution }) {
  if (contribution.attribution?.kind === "system") return <>Automated feedback</>;
  const names = [...new Set(contribution.prompts.map((prompt) => prompt.authorName))];
  return names.map((name, index) => <Fragment key={name}>{index > 0 ? ", " : ""}<PersonName name={name} /></Fragment>);
}

function ContributionCards({ source, onOpen, onRollback }: {
  source: ContributionSource;
  onOpen: (runId: string) => void;
  onRollback: (runId: string) => void;
}) {
  if (source.loading && source.items.length === 0) return <p className="review-empty">Loading prompt attribution…</p>;
  if (source.error) return <p className="review-empty" role="alert">Prompt attribution could not be loaded.</p>;
  if (source.items.length === 0) return <p className="review-empty">No active prompt attribution for this file.</p>;
  return <div className="review-contribution-cards" aria-label="Prompt contributions">
    {source.items.map((contribution) => <details key={contribution.runId} className="review-contribution-card">
      <summary><span><strong>{contribution.agentName}</strong><small><EngineerNames contribution={contribution} /></small></span><span className="queue-chip" data-kind="status" data-status={contribution.rollbackStatus ?? "active"}>{contributionLabel(contribution)}</span></summary>
      <RunAttributionInfo attribution={contribution.attribution} promptedBy={contribution.prompts.map((prompt) => ({ userId: prompt.authorUserId, name: prompt.authorName, deleted: Boolean(prompt.authorDeleted) }))} commitUrl={contribution.commitUrl} />
      <p>{contributionPreview(contribution)}</p>
      {contribution.rollbackStatus === "failed" && contribution.rollbackFailureReason && <p className="review-empty" role="alert">{contribution.rollbackFailureReason}</p>}
      <div className="review-contribution-actions"><button type="button" className="button" data-size="sm" onClick={() => onOpen(contribution.runId)}>View prompt changes</button>{contribution.canRollback && <button type="button" className="button danger-button" data-size="sm" onClick={() => onRollback(contribution.runId)}>Remove changes</button>}</div>
    </details>)}
  </div>;
}

function PromptContributionDetail({ detail, status, onRollback }: {
  detail: ContributionDetailSource;
  status: "active" | "rolled_back";
  onRollback: (intent: RollbackIntent) => void;
}) {
  if (detail.loading) return <section className="review-pane review-prompt-detail"><p className="review-empty">Loading historical changes…</p></section>;
  if (detail.error) return <section className="review-pane review-prompt-detail"><p className="review-empty" role="alert">{detail.error}</p></section>;
  const contribution = detail.contribution;
  if (!contribution) return <section className="review-pane review-prompt-detail"><div className="review-empty-state"><Icon name="file" size={22} /><h2>Select a prompt</h2><p>Choose a prompt group to inspect its original historical diff.</p></div></section>;
  return <section className="review-pane review-prompt-detail" aria-label="Prompt contribution detail">
    <div className="review-pane-head"><div><h3>{contribution.prompts.length === 1 ? "Prompt changes" : `${contribution.prompts.length} merged prompts`}</h3><small>{contribution.agentName} · <EngineerNames contribution={contribution} /></small></div><span className="queue-chip" data-kind="status" data-status={contribution.rollbackStatus ?? "active"}>{contributionLabel(contribution)}</span></div>
    <div className="review-prompt-detail-body">
      <RunAttributionInfo attribution={contribution.attribution} promptedBy={contribution.prompts.map((prompt) => ({ userId: prompt.authorUserId, name: prompt.authorName, deleted: Boolean(prompt.authorDeleted) }))} commitUrl={contribution.commitUrl} />
      <ol className="review-prompt-copy">{contribution.prompts.map((prompt) => <li key={prompt.id}><strong><PersonName name={prompt.authorName} /></strong><p>{prompt.text}</p><small><LocalDateTime timestamp={prompt.createdAt} /></small></li>)}</ol>
      {contribution.rollbackStatus === "failed" && contribution.rollbackFailureReason && <p className="review-empty" role="alert">{contribution.rollbackFailureReason}</p>}
      {status === "active" && contribution.canRollback && <div className="review-prompt-detail-actions"><button type="button" className="button danger-button" onClick={() => onRollback({ scope: "prompt", subjectId: contribution.runId })}>Remove changes</button></div>}
      <div className="review-historical-files"><span className="label">Original historical diff</span>{contribution.files.length === 0 ? <p className="review-empty">No historical diff was recorded.</p> : contribution.files.map((file) => <details key={file.id} open className="review-historical-file"><summary><code>{file.path}</code><span className="diff-stat"><i className="add">+{file.additions}</i><i className="del">−{file.deletions}</i></span></summary>{file.summary && <p className="review-summary">{file.summary}</p>}{file.diff && file.diff.length > 0 ? <pre className="review-code" aria-label={`Historical diff for ${file.path}`}>{file.diff.map((line, index) => <span key={`${index}-${line.text}`} className="review-line" data-type={line.type}><i>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</i><code>{line.text}</code></span>)}</pre> : <p className="review-empty">No diff preview available.</p>}</details>)}</div>
    </div>
  </section>;
}

function ContributorList({ title, facets, selectedId, owner, scope, onFilter, onRollback }: {
  title: string;
  facets: ReviewContributorFacet[];
  selectedId: string | null;
  owner: boolean;
  scope: "engineer" | "agent";
  onFilter: (id: string | null) => void;
  onRollback: (intent: RollbackIntent) => void;
}) {
  return <section className="review-pane"><div className="review-pane-head"><h3>{title}</h3><span>{facets.length}</span></div>{facets.length === 0 ? <p className="review-empty">No active contributors.</p> : <ul className="review-contributor-list">{facets.map((facet) => <li key={facet.id} data-selected={selectedId === facet.id ? "true" : undefined}><button type="button" className="review-contributor-filter" aria-pressed={selectedId === facet.id} onClick={() => onFilter(selectedId === facet.id ? null : facet.id)}><strong><PersonName name={facet.name} /></strong><small>{facet.activePromptGroups} group{facet.activePromptGroups === 1 ? "" : "s"} · {facet.activeFiles} file{facet.activeFiles === 1 ? "" : "s"}</small></button>{owner && <button type="button" className="button danger-button" data-size="sm" onClick={() => onRollback({ scope, subjectId: facet.id })}>Remove all changes</button>}</li>)}</ul>}</section>;
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

function requesterNames(requestedBy: ReviewContributor["requestedBy"]) {
  if (requestedBy.length === 0) return "no recorded human prompter";
  const shown = requestedBy.length <= 2 ? requestedBy : requestedBy.slice(0, 1);
  return <>{shown.map((requester, index) => <Fragment key={requester.userId}>{index > 0 ? ", " : ""}<PersonName name={requester.userName} /></Fragment>)}{requestedBy.length > 2 && ` +${requestedBy.length - 1}`}</>;
}

function contributorTitle(contributors: ReviewContributor[]) {
  return contributors.map((contributor) => `${contributor.agentName} · asked by ${contributor.requestedBy.map((requester) => requester.userName).join(", ")}`).join("\n");
}

function FileAttribution({ contributors, expanded }: { contributors: ReviewContributor[]; expanded?: boolean }) {
  if (contributors.length === 0) return <span className="review-attribution is-empty">Unattributed</span>;
  if (expanded) return <span className="review-attribution" data-expanded="true">{contributors.map((contributor) => <span key={contributor.agentId} className="review-attribution-row" data-tone={agentTone(contributor.agentId)}><span className="queue-chip" data-kind="agent" data-tone={agentTone(contributor.agentId)}>{contributor.agentName}</span><span className="review-attribution-who">asked by {requesterNames(contributor.requestedBy)}</span></span>)}</span>;
  const [first, ...rest] = contributors;
  return <span className="review-attribution" data-tone={agentTone(first.agentId)} title={contributorTitle(contributors)}><span className="queue-chip" data-kind="agent" data-tone={agentTone(first.agentId)}>{first.agentName}</span><span className="review-attribution-who">asked by {requesterNames(first.requestedBy)}</span>{rest.length > 0 && <span className="review-attribution-more">+{rest.length}</span>}</span>;
}

function ReadyConfirmDialog({ busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="ready-confirm-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="ready-confirm-title">Mark this pull request ready for review?</h2><p>GitHub converts the draft pull request into a normal pull request, signaling to reviewers that the candidate is ready. You can convert it back to a draft afterward.</p></div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        <button type="button" className="button primary-button" onClick={() => void onConfirm()} disabled={busy}>Ready for review</button>
      </div>
    </dialog>
  );
}

function UnreadyConfirmDialog({ busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="unready-confirm-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="unready-confirm-title">Convert this pull request back to a draft?</h2><p>GitHub marks the pull request as a draft again, signaling the candidate is no longer ready for review. You can mark it ready again at any time.</p></div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={() => void onConfirm()} disabled={busy}>Mark as not ready</button>
      </div>
    </dialog>
  );
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

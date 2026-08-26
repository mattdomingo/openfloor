"use client";

import { useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { AgentRun, FloorAgent, FloorQueueItem } from "@/lib/floor-types";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { QueueOrderMode, QueueScope } from "./data";
import { queueItemDestination, runStatusToken } from "./data";
import { AgentTargetMenu } from "./AgentTargetMenu";
import { Icon, SegmentedControl } from "./primitives";
import { Panel, type PanelChrome } from "./Rail";
import { QueueOrderMenu } from "./QueueOrderMenu";

const scopeOptions: { value: QueueScope; label: string }[] = [{ value: "mine", label: "You" }, { value: "team", label: "Team" }];

export function PromptQueue({ chrome, items, runs, agents, owner, runEnabled, busy, autoDispatch, onAutoDispatch, autoResolveConflicts, onAutoResolveConflicts, browserConflictAlerts, onBrowserConflictAlerts, onRun, onCancel, onDiscard, onRollback, onRetry, onEditPrompt, onPause, onDelete, onSetAgent, currentUserId, scope, onScope, orderMode, onOrderMode, draggedItemId, onItemDragStart, onItemDragEnd, onItemDrop, onFocusAgent, onOpenReview }: {
  chrome: PanelChrome;
  items: FloorQueueItem[];
  runs: AgentRun[];
  agents: FloorAgent[];
  owner: boolean;
  runEnabled: boolean;
  busy: boolean;
  autoDispatch: boolean;
  onAutoDispatch: (enabled: boolean) => Promise<void>;
  autoResolveConflicts: boolean;
  onAutoResolveConflicts: (enabled: boolean) => Promise<void>;
  browserConflictAlerts: boolean;
  onBrowserConflictAlerts: (enabled: boolean) => Promise<void>;
  onRun: (queueItemId: string) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
  onDiscard: (runId: string) => Promise<void>;
  onRollback: (runId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
  onEditPrompt: (queueItemId: string, promptId: string, text: string) => Promise<boolean>;
  onPause: (queueItemId: string, paused: boolean) => Promise<void>;
  onDelete: (queueItemId: string) => Promise<void>;
  onSetAgent: (queueItemId: string, agentId: string) => Promise<void>;
  currentUserId: string;
  scope: QueueScope;
  onScope: (scope: QueueScope) => void;
  orderMode: QueueOrderMode;
  onOrderMode: (mode: QueueOrderMode) => void;
  draggedItemId: string | null;
  onItemDragStart: (id: string) => void;
  onItemDragEnd: () => void;
  onItemDrop: (targetId: string) => void;
  onFocusAgent: (agentId: string) => void;
  onOpenReview: (runId: string, status: "active" | "rolled_back") => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [detailOpen, setDetailOpen] = useState<Record<string, boolean>>({});
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const canReorder = scope === "team";
  const manual = orderMode === "manual" && canReorder;
  const scoped = scope === "mine" ? items.filter((item) => item.prompts.some((prompt) => prompt.authorUserId === currentUserId)) : items;
  const isDone = (item: FloorQueueItem) => {
    const run = runs.find((candidate) => candidate.queueItemId === item.id);
    return runStatusToken(run) === "integrated" || item.rollback?.status === "completed" || runStatusToken(run) === "answered" || item.status === "cancelled";
  };
  const visible = [...scoped].sort((a, b) => Number(isDone(a)) - Number(isDone(b)));

  return <Panel chrome={chrome} title="Queue" meta={`${visible.length} waiting`} actions={<>
    <QueueOrderMenu mode={orderMode} onChange={onOrderMode} canReorder={canReorder} owner={owner} autoDispatch={autoDispatch} onAutoDispatch={onAutoDispatch} autoResolveConflicts={autoResolveConflicts} onAutoResolveConflicts={onAutoResolveConflicts} browserConflictAlerts={browserConflictAlerts} onBrowserConflictAlerts={onBrowserConflictAlerts} busy={busy} />
    <SegmentedControl label="Queue scope" value={scope} onChange={onScope} options={scopeOptions} />
  </>}>
    {visible.length === 0 ? <div className="queue-empty"><strong>No prompts waiting</strong><p>Submit a prompt below with an agent target or leave it unassigned.</p></div> : <ul className="queue-list">{visible.map((item) => {
      const open = expanded[item.id] === true;
      const long = item.prompts.length > 3 || item.prompts.some((prompt) => prompt.text.length > 110);
      const first = item.prompts[0];
      const run = runs.find((candidate) => candidate.queueItemId === item.id);
      const cancellable = run && ["provisioning", "running", "checking", "cancel_requested"].includes(run.status);
      // A resumed prompt goes back to "queued"/"paused" immediately, but its last
      // run row (if any) can still carry a stale failed/cancelled status — the
      // queue item's own state wins once it's back in a not-yet-run state.
      const rollbackStatus = item.rollback?.status === "requested" || item.rollback?.status === "running" ? "rolling_back"
        : item.rollback?.status === "completed" ? "rolled_back"
        : item.rollback?.status === "failed" ? "rollback_failed" : null;
      const statusValue = item.status === "queued" || item.status === "paused"
        ? item.status
        : rollbackStatus ?? (run?.discardedAt ? "discarded" : run ? runStatusToken(run) : item.status);
      const editing = editingId === item.id;
      const mine = item.prompts.length > 0 && item.prompts.every((prompt) => prompt.authorUserId === currentUserId);
      const manageable = (owner || mine) && item.prompts.length === 1;
      const editable = manageable && (item.status === "queued" || item.status === "paused");
      const pausable = manageable && item.status === "queued";
      const resumable = manageable && ["paused", "failed", "cancelled"].includes(item.status);
      const deletable = manageable && ["queued", "paused", "failed", "cancelled"].includes(item.status);
      // The only other assigner is the router's assign phase, which never
      // runs while auto-dispatch is off — without this, a prompt submitted
      // with target "Auto" in that state has no path to a Run button at all.
      const retargetable = manageable && item.status === "queued" && !item.agentId && agents.length > 0;
      const rollbackAllowed = item.rollback?.canStart === true;
      const destination = editing ? null : queueItemDestination(item, run);
      const detailShown = destination?.kind === "detail" && detailOpen[item.id] === true;
      function activateDestination() {
        if (!destination) return;
        if (destination.kind === "agent") onFocusAgent(destination.agentId);
        else if (destination.kind === "review") onOpenReview(destination.runId, destination.status);
        else setDetailOpen((current) => ({ ...current, [item.id]: !current[item.id] }));
      }
      // Clicks that land on a button/link/form control inside the card (Run,
      // Delete, the agent-target menu, the edit textarea, ...) act on their
      // own — only a click on the card's otherwise-inert surface opens the
      // destination.
      function onCardClick(event: ReactMouseEvent<HTMLLIElement>) {
        if ((event.target as HTMLElement).closest("button, a, textarea, input, select, [role=\"combobox\"]")) return;
        activateDestination();
      }
      return <li key={item.id} className="queue-item" data-done={(statusValue === "integrated" || statusValue === "rolled_back" || statusValue === "cancelled" || statusValue === "answered") ? "true" : undefined} data-attention={(statusValue === "failed" || statusValue === "rollback_failed") ? "true" : undefined} data-manual={manual ? "true" : undefined} data-clickable={destination ? "true" : undefined} data-dragging={draggedItemId === item.id ? "true" : undefined} data-drop-target={dragOverId === item.id ? "true" : undefined} draggable={manual}
        onClick={destination ? onCardClick : undefined}
        onDragStart={manual ? () => onItemDragStart(item.id) : undefined}
        onDragEnd={manual ? () => { setDragOverId(null); onItemDragEnd(); } : undefined}
        onDragOver={manual ? (event) => { event.preventDefault(); if (draggedItemId && draggedItemId !== item.id) setDragOverId(item.id); } : undefined}
        onDragLeave={manual ? (event: DragEvent<HTMLLIElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverId((current) => current === item.id ? null : current); } : undefined}
        onDrop={manual ? () => { setDragOverId(null); onItemDrop(item.id); } : undefined}>
        <div className="queue-item-head"><span className="queue-identity">{manual && <span className="queue-grip" title="Drag to reorder" aria-hidden="true"><Icon name="grip" /></span>}<span className="queue-position" aria-label={`Queue position ${item.position}`}>#{item.position}</span><span className="queue-chip" data-kind="author">{item.prompts.length > 1 ? `${item.prompts.length} prompts` : first?.authorName}</span>{item.agentId ? <button type="button" className="queue-chip queue-chip-button" data-kind={item.assignedBy === "router" ? "agent-auto" : "agent"} title={item.assignedBy === "router" ? item.assignedReason ?? "Assigned automatically" : "Open this agent"} onClick={() => onFocusAgent(item.agentId!)}>{item.agentName ?? "Unassigned"}{item.assignedBy === "router" && " · auto"}</button> : retargetable ? <AgentTargetMenu value={null} agents={agents} allowAuto={false} onChange={(agentId) => { if (agentId) void onSetAgent(item.id, agentId); }} /> : <span className="queue-chip" data-kind="agent">Unassigned</span>}</span>{item.intent === "question" && <span className="queue-chip" data-kind="intent">Question</span>}{item.intent === "noise" && <span className="queue-chip" data-kind="intent">Not a task</span>}{first && <span className="queue-time"><LocalDateTime timestamp={first.createdAt} /></span>}</div>
        {editing ? <form className="queue-edit-form" onSubmit={(event) => { event.preventDefault(); const text = draftText.trim(); if (!text || !first) return; void onEditPrompt(item.id, first.id, text).then((ok) => { if (ok) setEditingId(null); }); }}>
          <textarea className="queue-edit-textarea" value={draftText} onChange={(event) => setDraftText(event.target.value)} maxLength={4000} autoFocus />
          <div className="queue-edit-actions">
            <button type="submit" className="button" data-size="sm" disabled={busy || !draftText.trim()}>Save</button>
            <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
          </div>
        </form> : <>
          {item.prompts.length > 1 ? <ul className="queue-prompt queue-prompt-stack" data-expanded={open ? "true" : "false"}>{item.prompts.map((prompt) => <li key={prompt.id}><strong>{prompt.authorName}</strong> · {prompt.text}</li>)}</ul> : <p className="queue-prompt" data-expanded={open ? "true" : "false"}>{first?.text}</p>}
          {long && <button type="button" className="queue-expand" aria-expanded={open} onClick={() => setExpanded((current) => ({ ...current, [item.id]: !open }))}>{open ? "Show less" : "Show more"}</button>}
        </>}
        {detailShown && run && <QueueItemDetail run={run} item={item} onFocusAgent={onFocusAgent} />}
        <div className="queue-run-row">{run?.purpose === "conflict_resolution" && <span className="queue-chip" data-kind="agent-auto">Merge Resolver</span>}{destination ? <button type="button" className="queue-chip queue-chip-button" data-kind="status" data-status={statusValue} title={item.rollback?.failureReason ?? run?.rollbackFailureReason ?? undefined} aria-expanded={destination.kind === "detail" ? detailShown : undefined} onClick={activateDestination}>{statusValue.replace("_", " ")}</button> : <span className="queue-chip" data-kind="status" data-status={statusValue} title={item.rollback?.failureReason ?? run?.rollbackFailureReason ?? undefined}>{statusValue.replace("_", " ")}</span>}{run?.runBranch && <code className="queue-run-branch">{run.runBranch}</code>}{owner && runEnabled && item.status === "queued" && item.agentId && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onRun(item.id)}>Run</button>}{owner && cancellable && run.status !== "cancel_requested" && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onCancel(run.id)}>Cancel</button>}{owner && run?.status === "published" && !run.discardedAt && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onDiscard(run.id)}>Discard candidate</button>}{rollbackAllowed && item.rollback && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onRollback(item.rollback!.runId)}>Remove changes</button>}{owner && run?.status === "conflicted" && !run.conflictCaseId && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onRetry(run.id)}>Retry against latest candidate</button>}{!editing && editable && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => { setEditingId(item.id); setDraftText(first?.text ?? ""); }}>Edit</button>}{pausable && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onPause(item.id, true)}>Pause</button>}{resumable && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onPause(item.id, false)}>Resume</button>}{deletable && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onDelete(item.id)}>Delete</button>}</div>
      </li>;
    })}</ul>}
  </Panel>;
}

// A failed/conflicted/cancelled/answered run has no other spot in the
// queue — the saved reason the agent (or the run pipeline) recorded, inline
// next to the Resume/Delete buttons that act on it. AgentSpotlight shows the
// same data plus the raw log; "Open agent" jumps there for that.
function QueueItemDetail({ run, item, onFocusAgent }: { run: AgentRun; item: FloorQueueItem; onFocusAgent: (agentId: string) => void }) {
  const token = runStatusToken(run);
  const failedChecks = run.checks.filter((check) => check.status === "failed" || check.status === "timed_out");
  const rollbackFailure = item.rollback?.failureReason ?? run.rollbackFailureReason;
  return <div className="queue-detail">
    <div className="queue-detail-head"><strong>{run.agentName}</strong><span>{token.replace("_", " ")}</span></div>
    {run.kind === "reply" && run.finalResponse && <p className="queue-detail-body">{run.finalResponse}</p>}
    {run.kind !== "reply" && run.summary && <p className="queue-detail-body">{run.summary}</p>}
    {run.conflictReason && <p className="queue-detail-body">{run.conflictReason}</p>}
    {rollbackFailure && <p className="queue-detail-body">{rollbackFailure}</p>}
    {failedChecks.length > 0 && <ul className="queue-detail-checks">{failedChecks.map((check) => <li key={check.id}><code>{check.command}</code>{check.outputExcerpt && <pre>{check.outputExcerpt}</pre>}</li>)}</ul>}
    <button type="button" className="button" data-size="sm" onClick={() => onFocusAgent(run.agentId)}>Open agent</button>
  </div>;
}

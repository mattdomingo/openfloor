"use client";

import { useState, type DragEvent } from "react";
import type { AgentRun, FloorQueueItem } from "@/lib/floor-types";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { QueueMergeMode, QueueOrderMode, QueueScope } from "./data";
import { Icon, SegmentedControl } from "./primitives";
import { Panel, type PanelChrome } from "./Rail";
import { QueueOrderMenu } from "./QueueOrderMenu";

const scopeOptions: { value: QueueScope; label: string }[] = [{ value: "mine", label: "You" }, { value: "team", label: "Team" }];

export function PromptQueue({ chrome, items, runs, owner, runEnabled, busy, autoDispatch, onAutoDispatch, onRun, onCancel, onDiscard, onRetry, onEditPrompt, onPause, onDelete, currentUserId, scope, onScope, orderMode, onOrderMode, mergeMode, onMergeMode, onMergeNow, draggedItemId, onItemDragStart, onItemDragEnd, onItemDrop, onFocusAgent }: {
  chrome: PanelChrome;
  items: FloorQueueItem[];
  runs: AgentRun[];
  owner: boolean;
  runEnabled: boolean;
  busy: boolean;
  autoDispatch: boolean;
  onAutoDispatch: (enabled: boolean) => Promise<void>;
  onRun: (queueItemId: string) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
  onDiscard: (runId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
  onEditPrompt: (queueItemId: string, promptId: string, text: string) => Promise<boolean>;
  onPause: (queueItemId: string, paused: boolean) => Promise<void>;
  onDelete: (queueItemId: string) => Promise<void>;
  currentUserId: string;
  scope: QueueScope;
  onScope: (scope: QueueScope) => void;
  orderMode: QueueOrderMode;
  onOrderMode: (mode: QueueOrderMode) => void;
  mergeMode: QueueMergeMode;
  onMergeMode: (mode: QueueMergeMode) => void;
  onMergeNow: () => void;
  draggedItemId: string | null;
  onItemDragStart: (id: string) => void;
  onItemDragEnd: () => void;
  onItemDrop: (targetId: string) => void;
  onFocusAgent: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const canReorder = scope === "team";
  const manual = orderMode === "manual" && canReorder;
  const scoped = scope === "mine" ? items.filter((item) => item.prompts.some((prompt) => prompt.authorUserId === currentUserId)) : items;
  const isDone = (item: FloorQueueItem) => {
    const status = runs.find((candidate) => candidate.queueItemId === item.id)?.status;
    return status === "integrated" || item.status === "cancelled";
  };
  const visible = [...scoped].sort((a, b) => Number(isDone(a)) - Number(isDone(b)));

  return <Panel chrome={chrome} title="Queue" meta={`${visible.length} waiting`} actions={<>
    <SegmentedControl label="Queue scope" value={scope} onChange={onScope} options={scopeOptions} />
    <QueueOrderMenu mode={orderMode} onChange={onOrderMode} mergeMode={mergeMode} onMergeMode={onMergeMode} onMergeNow={onMergeNow} canReorder={canReorder} owner={owner} autoDispatch={autoDispatch} onAutoDispatch={onAutoDispatch} busy={busy} />
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
      const statusValue = item.status === "queued" || item.status === "paused"
        ? item.status
        : run?.discardedAt ? "discarded" : run?.status ?? item.status;
      const editing = editingId === item.id;
      const mine = item.prompts.length > 0 && item.prompts.every((prompt) => prompt.authorUserId === currentUserId);
      const manageable = (owner || mine) && item.prompts.length === 1;
      const editable = manageable && (item.status === "queued" || item.status === "paused");
      const pausable = manageable && item.status === "queued";
      const resumable = manageable && ["paused", "failed", "cancelled"].includes(item.status);
      const deletable = manageable && ["queued", "paused", "failed", "cancelled"].includes(item.status);
      return <li key={item.id} className="queue-item" data-done={(statusValue === "integrated" || statusValue === "cancelled") ? "true" : undefined} data-attention={statusValue === "failed" ? "true" : undefined} data-manual={manual ? "true" : undefined} data-dragging={draggedItemId === item.id ? "true" : undefined} data-drop-target={dragOverId === item.id ? "true" : undefined} draggable={manual}
        onDragStart={manual ? () => onItemDragStart(item.id) : undefined}
        onDragEnd={manual ? () => { setDragOverId(null); onItemDragEnd(); } : undefined}
        onDragOver={manual ? (event) => { event.preventDefault(); if (draggedItemId && draggedItemId !== item.id) setDragOverId(item.id); } : undefined}
        onDragLeave={manual ? (event: DragEvent<HTMLLIElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverId((current) => current === item.id ? null : current); } : undefined}
        onDrop={manual ? () => { setDragOverId(null); onItemDrop(item.id); } : undefined}>
        <div className="queue-item-head"><span className="queue-identity">{manual && <span className="queue-grip" title="Drag to reorder" aria-hidden="true"><Icon name="grip" /></span>}<span className="queue-position" aria-label={`Queue position ${item.position}`}>#{item.position}</span><span className="queue-chip" data-kind="author">{item.prompts.length > 1 ? `${item.prompts.length} prompts` : first?.authorName}</span>{item.agentId ? <button type="button" className="queue-chip queue-chip-button" data-kind={item.assignedBy === "router" ? "agent-auto" : "agent"} title={item.assignedBy === "router" ? item.assignedReason ?? "Assigned automatically" : "Open this agent"} onClick={() => onFocusAgent(item.agentId!)}>{item.agentName ?? "Unassigned"}{item.assignedBy === "router" && " · auto"}</button> : <span className="queue-chip" data-kind="agent">Unassigned</span>}</span>{first && <span className="queue-time"><LocalDateTime timestamp={first.createdAt} /></span>}</div>
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
        <div className="queue-run-row"><span className="queue-chip" data-kind="status" data-status={statusValue}>{statusValue.replace("_", " ")}</span>{run?.runBranch && <code className="queue-run-branch">{run.runBranch}</code>}{owner && runEnabled && item.status === "queued" && item.agentId && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onRun(item.id)}>Run</button>}{owner && cancellable && run.status !== "cancel_requested" && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onCancel(run.id)}>Cancel</button>}{owner && run?.status === "published" && !run.discardedAt && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onDiscard(run.id)}>Discard candidate</button>}{owner && run?.status === "conflicted" && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onRetry(run.id)}>Retry against latest candidate</button>}{!editing && editable && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => { setEditingId(item.id); setDraftText(first?.text ?? ""); }}>Edit</button>}{pausable && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onPause(item.id, true)}>Pause</button>}{resumable && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onPause(item.id, false)}>Resume</button>}{deletable && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onDelete(item.id)}>Delete</button>}</div>
      </li>;
    })}</ul>}
  </Panel>;
}

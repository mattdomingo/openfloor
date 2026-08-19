"use client";

import { useState, type DragEvent } from "react";
import type { AgentRun, FloorQueueItem } from "@/lib/floor-types";
import { formatShortDate, formatShortTime } from "@/lib/date-format";
import type { QueueMergeMode, QueueOrderMode, QueueScope } from "./data";
import { Icon, SegmentedControl } from "./primitives";
import { Panel, type PanelChrome } from "./Rail";
import { QueueOrderMenu } from "./QueueOrderMenu";

const scopeOptions: { value: QueueScope; label: string }[] = [{ value: "mine", label: "You" }, { value: "team", label: "Team" }];

export function PromptQueue({ chrome, items, runs, owner, runEnabled, busy, onRun, onCancel, onDiscard, onRetry, currentUserId, scope, onScope, orderMode, onOrderMode, mergeMode, onMergeMode, onMergeNow, draggedItemId, onItemDragStart, onItemDragEnd, onItemDrop }: {
  chrome: PanelChrome;
  items: FloorQueueItem[];
  runs: AgentRun[];
  owner: boolean;
  runEnabled: boolean;
  busy: boolean;
  onRun: (queueItemId: string) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
  onDiscard: (runId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
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
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const canReorder = scope === "team";
  const manual = orderMode === "manual" && canReorder;
  const visible = scope === "mine" ? items.filter((item) => item.prompts.some((prompt) => prompt.authorUserId === currentUserId)) : items;

  return <Panel chrome={chrome} title="Queue" meta={`${visible.length} waiting`} badge={`${visible.length}`} actions={<QueueOrderMenu mode={orderMode} onChange={onOrderMode} mergeMode={mergeMode} onMergeMode={onMergeMode} onMergeNow={onMergeNow} canReorder={canReorder} />}>
    <div className="queue-toolbar"><SegmentedControl label="Queue scope" value={scope} onChange={onScope} options={scopeOptions} /></div>
    {visible.length === 0 ? <div className="queue-empty"><strong>No prompts waiting</strong><p>Submit a prompt below with an agent target or leave it unassigned.</p></div> : <ul className="queue-list">{visible.map((item) => {
      const open = expanded[item.id] === true;
      const long = item.prompts.length > 3 || item.prompts.some((prompt) => prompt.text.length > 110);
      const first = item.prompts[0];
      const run = runs.find((candidate) => candidate.queueItemId === item.id);
      const cancellable = run && ["provisioning", "running", "checking", "cancel_requested"].includes(run.status);
      return <li key={item.id} className="queue-item" data-manual={manual ? "true" : undefined} data-dragging={draggedItemId === item.id ? "true" : undefined} data-drop-target={dragOverId === item.id ? "true" : undefined} draggable={manual}
        onDragStart={manual ? () => onItemDragStart(item.id) : undefined}
        onDragEnd={manual ? () => { setDragOverId(null); onItemDragEnd(); } : undefined}
        onDragOver={manual ? (event) => { event.preventDefault(); if (draggedItemId && draggedItemId !== item.id) setDragOverId(item.id); } : undefined}
        onDragLeave={manual ? (event: DragEvent<HTMLLIElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverId((current) => current === item.id ? null : current); } : undefined}
        onDrop={manual ? () => { setDragOverId(null); onItemDrop(item.id); } : undefined}>
        <div className="queue-item-head"><span className="queue-identity">{manual && <span className="queue-grip" title="Drag to reorder" aria-hidden="true"><Icon name="grip" /></span>}<span className="queue-position" aria-label={`Queue position ${item.position}`}>#{item.position}</span><span className="queue-chip" data-kind="author">{item.prompts.length > 1 ? `${item.prompts.length} prompts` : first?.authorName}</span><span className="queue-chip" data-kind="agent">{item.agentName ?? "Unassigned"}</span></span>{first && <span className="queue-time">{formatShortDate(first.createdAt)} · {formatShortTime(first.createdAt)} UTC</span>}</div>
        {item.prompts.length > 1 ? <ul className="queue-prompt queue-prompt-stack" data-expanded={open ? "true" : "false"}>{item.prompts.map((prompt) => <li key={prompt.id}><strong>{prompt.authorName}</strong> · {prompt.text}</li>)}</ul> : <p className="queue-prompt" data-expanded={open ? "true" : "false"}>{first?.text}</p>}
        {long && <button type="button" className="queue-expand" aria-expanded={open} onClick={() => setExpanded((current) => ({ ...current, [item.id]: !open }))}>{open ? "Show less" : "Show more"}</button>}
        <div className="queue-run-row"><span className="queue-chip" data-kind="status">{run?.discardedAt ? "discarded" : run?.status.replace("_", " ") ?? item.status}</span>{run?.runBranch && <code className="queue-run-branch">{run.runBranch}</code>}{owner && runEnabled && item.status === "queued" && item.agentId && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onRun(item.id)}>Run</button>}{owner && cancellable && run.status !== "cancel_requested" && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onCancel(run.id)}>Cancel</button>}{owner && run?.status === "published" && !run.discardedAt && <button type="button" className="button danger-button" data-size="sm" disabled={busy} onClick={() => void onDiscard(run.id)}>Discard candidate</button>}{owner && run?.status === "conflicted" && <button type="button" className="button" data-size="sm" disabled={busy} onClick={() => void onRetry(run.id)}>Retry against latest candidate</button>}</div>
      </li>;
    })}</ul>}
  </Panel>;
}

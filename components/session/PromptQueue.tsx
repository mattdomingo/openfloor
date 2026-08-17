"use client";

import { useState, type CSSProperties, type DragEvent } from "react";
import { QueueItem, QueueMergeMode, QueueOrderMode, QueueScope } from "./data";
import { Icon, SegmentedControl } from "./primitives";
import { Panel, PanelChrome } from "./Rail";
import { QueueOrderMenu } from "./QueueOrderMenu";

const scopeOptions: { value: QueueScope; label: string }[] = [
  { value: "mine", label: "You" },
  { value: "team", label: "Team" },
];

export function PromptQueue({
  chrome,
  items,
  scope,
  onScope,
  orderMode,
  onOrderMode,
  mergeMode,
  onMergeMode,
  onMergeNow,
  mergingIds,
  draggedItemId,
  onItemDragStart,
  onItemDragEnd,
  onItemDrop,
  selectedAgentName,
}: {
  chrome: PanelChrome;
  items: QueueItem[];
  scope: QueueScope;
  onScope: (scope: QueueScope) => void;
  orderMode: QueueOrderMode;
  onOrderMode: (mode: QueueOrderMode) => void;
  mergeMode: QueueMergeMode;
  onMergeMode: (mode: QueueMergeMode) => void;
  onMergeNow: () => void;
  mergingIds: string[];
  draggedItemId: string | null;
  onItemDragStart: (id: string) => void;
  onItemDragEnd: () => void;
  onItemDrop: (targetId: string) => void;
  selectedAgentName: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const canReorder = scope === "team";
  const manual = orderMode === "manual" && canReorder;
  const sorted = scope === "mine" ? items.filter((item) => item.author === "You") : items;

  return (
    <Panel
      chrome={chrome}
      title="Queue"
      meta={`${sorted.length} waiting`}
      badge={`${sorted.length}`}
      actions={
        <QueueOrderMenu
          mode={orderMode}
          onChange={onOrderMode}
          mergeMode={mergeMode}
          onMergeMode={onMergeMode}
          onMergeNow={onMergeNow}
        />
      }
    >
      <div className="queue-toolbar">
        <SegmentedControl label="Queue scope" value={scope} onChange={onScope} options={scopeOptions} />
      </div>

      {sorted.length === 0 ? (
        <div className="queue-empty">
          <strong>{scope === "mine" ? "Your queue is clear" : "No prompts waiting"}</strong>
          <p>
            {scope === "mine"
              ? `Queue work for ${selectedAgentName} from the composer below. Drafts from teammates stay in their text boxes until submitted.`
              : "When someone submits from the floor, it lands here until an agent picks it up."}
          </p>
        </div>
      ) : (
        <ul className="queue-list">
          {sorted.map((item) => {
            const long = (item.mergedFrom?.join(" ") ?? item.prompt).length > 110;
            const open = expanded[item.id] === true;
            return (
              <li
                key={item.id}
                className="queue-item"
                data-manual={manual ? "true" : undefined}
                data-dragging={draggedItemId === item.id ? "true" : undefined}
                data-drop-target={dragOverId === item.id ? "true" : undefined}
                data-merging={mergingIds.includes(item.id) ? "true" : undefined}
                draggable={manual}
                onDragStart={manual ? () => onItemDragStart(item.id) : undefined}
                onDragEnd={
                  manual
                    ? () => {
                        setDragOverId(null);
                        onItemDragEnd();
                      }
                    : undefined
                }
                onDragOver={
                  manual
                    ? (event) => {
                        event.preventDefault();
                        if (draggedItemId && draggedItemId !== item.id) setDragOverId(item.id);
                      }
                    : undefined
                }
                onDragLeave={
                  manual
                    ? (event: DragEvent<HTMLLIElement>) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          setDragOverId((current) => (current === item.id ? null : current));
                        }
                      }
                    : undefined
                }
                onDrop={
                  manual
                    ? () => {
                        setDragOverId(null);
                        onItemDrop(item.id);
                      }
                    : undefined
                }
              >
                <div className="queue-item-head">
                  <span className="queue-identity">
                    {manual && (
                      <span className="queue-grip" title="Drag to reorder" aria-hidden="true">
                        <Icon name="grip" />
                      </span>
                    )}
                    <span className="queue-position" aria-label={`Queue position ${item.position}`}>
                      #{item.position}
                    </span>
                    <span className="queue-chip" data-kind="author" data-tone={item.authorTone}>
                      {item.author}
                    </span>
                    <span
                      className="queue-chip"
                      data-kind="agent"
                      style={{ "--agent-color": item.agentColor } as CSSProperties}
                    >
                      {item.agentName}
                    </span>
                    {item.routedByOpenMind && (
                      <span className="queue-chip" data-kind="router" title="OpenMind picked this agent">
                        OpenMind
                      </span>
                    )}
                    {item.mergedFrom && item.mergedFrom.length > 1 && (
                      <span
                        className="queue-chip"
                        data-kind="merged"
                        title={`${item.mergedFrom.length} prompts merged into this card`}
                      >
                        Merged ×{item.mergedFrom.length}
                      </span>
                    )}
                  </span>
                  <span className="queue-time">{item.queuedAt}</span>
                </div>
                {item.mergedFrom && item.mergedFrom.length > 1 ? (
                  <ul className="queue-prompt queue-prompt-stack" data-expanded={open ? "true" : "false"}>
                    {item.mergedFrom.map((text, index) => (
                      <li key={index}>{text}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="queue-prompt" data-expanded={open ? "true" : "false"}>
                    {item.prompt}
                  </p>
                )}
                {long && (
                  <button
                    type="button"
                    className="queue-expand"
                    aria-expanded={open}
                    onClick={() => setExpanded((current) => ({ ...current, [item.id]: !open }))}
                  >
                    {open ? "Show less" : "Show more"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

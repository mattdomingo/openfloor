"use client";

import { useState, type CSSProperties } from "react";
import { QueueItem, QueueOrderMode, QueueScope } from "./data";
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
  draggedItemId: string | null;
  onItemDragStart: (id: string) => void;
  onItemDragEnd: () => void;
  onItemDrop: (targetId: string) => void;
  selectedAgentName: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const canReorder = scope === "team";
  const manual = orderMode === "manual" && canReorder;
  const sorted = scope === "mine" ? items.filter((item) => item.author === "You") : items;

  return (
    <Panel
      chrome={chrome}
      title="Queue"
      meta={`${sorted.length} waiting`}
      badge={`${sorted.length}`}
      actions={canReorder ? <QueueOrderMenu mode={orderMode} onChange={onOrderMode} /> : undefined}
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
            const long = item.prompt.length > 110;
            const open = expanded[item.id] === true;
            return (
              <li
                key={item.id}
                className="queue-item"
                data-manual={manual ? "true" : undefined}
                data-dragging={draggedItemId === item.id ? "true" : undefined}
                draggable={manual}
                onDragStart={manual ? () => onItemDragStart(item.id) : undefined}
                onDragEnd={manual ? onItemDragEnd : undefined}
                onDragOver={manual ? (event) => event.preventDefault() : undefined}
                onDrop={manual ? () => onItemDrop(item.id) : undefined}
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
                  </span>
                  <span className="queue-time">{item.queuedAt}</span>
                </div>
                <p className="queue-prompt" data-expanded={open ? "true" : "false"}>
                  {item.prompt}
                </p>
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

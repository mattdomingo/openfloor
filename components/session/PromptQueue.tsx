"use client";

import { useState } from "react";
import { QueueItem, QueueScope } from "./data";
import { SegmentedControl } from "./primitives";
import { Panel, PanelChrome } from "./Rail";

const scopeOptions: { value: QueueScope; label: string }[] = [
  { value: "mine", label: "Your queue" },
  { value: "team", label: "Team queue" },
];

export function PromptQueue({
  chrome,
  items,
  scope,
  onScope,
  selectedAgentName,
}: {
  chrome: PanelChrome;
  items: QueueItem[];
  scope: QueueScope;
  onScope: (scope: QueueScope) => void;
  selectedAgentName: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const visible = scope === "mine" ? items.filter((item) => item.author === "You") : items;
  const sorted = [...visible].sort((a, b) => a.position - b.position);

  const controls = (
    <SegmentedControl label="Queue scope" value={scope} onChange={onScope} options={scopeOptions} />
  );

  return (
    <Panel
      chrome={chrome}
      title="Prompt queue"
      meta={`${sorted.length} waiting`}
      badge={`${sorted.length}`}
      actions={controls}
    >
      <p className="queue-lede">
        Submitted prompts waiting for an agent. Live drafts stay in the floor; active work stays on the agent floor.
      </p>

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
              <li key={item.id} className="queue-item">
                <div className="queue-item-head">
                  <span className="queue-position" aria-label={`Queue position ${item.position}`}>
                    #{item.position}
                  </span>
                  <span className="queue-status" data-status={item.status}>
                    {item.status === "waiting" ? "Waiting" : "Queued"}
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
                <div className="queue-meta">
                  <span className="queue-chip" data-kind="author" data-tone={item.authorTone}>
                    {item.author}
                  </span>
                  <span className="queue-chip" data-kind="agent">
                    {item.agentName}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

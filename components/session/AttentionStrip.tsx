"use client";

import { ReactNode, useEffect, useId, useRef, useState } from "react";
import { Agent, Check, scopeConflict, statusAlert } from "./data";
import { Icon, IconName } from "./primitives";

type AttentionKind = "conflict" | "blocked" | "needs-input" | "check" | "decision";

type AttentionItem = {
  id: string;
  kind: AttentionKind;
  title: ReactNode;
  detail: string;
  action?: { label: string; onClick: () => void; primary?: boolean };
};

const marks: Record<AttentionKind, IconName> = {
  conflict: "alert",
  blocked: "alert",
  "needs-input": "pencil",
  check: "clock",
  decision: "pencil",
};

function collectItems({
  agents,
  checks,
  conflictResolved,
  onResolveConflict,
  onOpenChecks,
  onNotice,
  onAnswer,
}: {
  agents: Agent[];
  checks: Check[];
  conflictResolved: boolean;
  onResolveConflict: () => void;
  onOpenChecks: () => void;
  onNotice: (notice: string) => void;
  onAnswer: (agent: Agent) => void;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (!conflictResolved) {
    items.push({
      id: "scope-conflict",
      kind: "conflict",
      title: (
        <>
          {scopeConflict.claimants} both claim <code>{scopeConflict.path}</code>
        </>
      ),
      detail: scopeConflict.recommendation,
      action: { label: "Apply resolution", onClick: onResolveConflict, primary: true },
    });
  }

  for (const agent of agents) {
    if (agent.status !== "blocked" && agent.status !== "needs-input") continue;
    const alert = statusAlert(agent);
    if (!alert) continue;
    items.push({
      id: `${agent.status}-${agent.id}`,
      kind: agent.status,
      title: agent.status === "blocked" ? `${agent.name} is blocked` : `${agent.name} needs your input`,
      detail: alert.body,
      action: {
        label: alert.action,
        /* Answering happens in the composer, not in a toast. */
        onClick: agent.status === "needs-input" ? () => onAnswer(agent) : () => onNotice(alert.notice),
      },
    });
  }

  for (const check of checks) {
    if (check.state === "passed") continue;
    items.push({
      id: `check-${check.id}`,
      kind: "check",
      title: check.state === "failed" ? `${check.name} failed` : `${check.name} is waiting`,
      detail: check.detail,
      action: { label: "View checks", onClick: onOpenChecks },
    });
  }

  return items;
}

export function AttentionStrip({
  agents,
  checks,
  conflictResolved,
  onResolveConflict,
  onOpenChecks,
  onNotice,
  onAnswer,
}: {
  agents: Agent[];
  checks: Check[];
  conflictResolved: boolean;
  onResolveConflict: () => void;
  onOpenChecks: () => void;
  onNotice: (notice: string) => void;
  onAnswer: (agent: Agent) => void;
}) {
  const items = collectItems({ agents, checks, conflictResolved, onResolveConflict, onOpenChecks, onNotice, onAnswer });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const panelOpen = open && items.length > 0;

  useEffect(() => {
    if (!panelOpen) return;

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen]);

  if (items.length === 0) return null;

  return (
    <div className="attention" data-open={panelOpen ? "true" : "false"} ref={rootRef}>
      <button
        type="button"
        className="attention-trigger"
        aria-expanded={panelOpen}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="alert" size={12} />
        <span className="attention-trigger-label">Needs you</span>
        <span className="attention-count">{items.length}</span>
        <Icon name="chevronDown" size={12} className="attention-caret" />
      </button>

      {/* A single anchored card, not a row of floating tiles: it opens upward
          from the trigger, scrolls internally, and covers nothing beside it. */}
      <div className="attention-panel" id={listId} role="group" aria-label="Needs you" hidden={!panelOpen}>
        <ul className="attention-list">
          {items.map((item) => (
            <li key={item.id} className="attention-item" data-kind={item.kind}>
              <span className="attention-mark">
                <Icon name={marks[item.kind]} size={12} />
              </span>
              <div className="attention-copy">
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
              </div>
              {item.action && (
                <button
                  type="button"
                  className="button"
                  data-size="sm"
                  data-variant={item.action.primary ? "primary" : undefined}
                  onClick={() => {
                    item.action?.onClick();
                    setOpen(false);
                  }}
                >
                  {item.action.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}


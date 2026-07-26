"use client";

import { ReactNode } from "react";
import { Agent, Check, scopeConflict } from "./data";
import { Icon, IconName } from "./primitives";

type AttentionKind = "conflict" | "blocked" | "check" | "decision";

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
  check: "clock",
  decision: "pencil",
};

export function AttentionStrip({
  agents,
  checks,
  conflictResolved,
  onResolveConflict,
  onOpenChecks,
  onNotice,
}: {
  agents: Agent[];
  checks: Check[];
  conflictResolved: boolean;
  onResolveConflict: () => void;
  onOpenChecks: () => void;
  onNotice: (notice: string) => void;
}) {
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
    if (agent.status !== "blocked") continue;
    items.push({
      id: `blocked-${agent.id}`,
      kind: "blocked",
      title: `${agent.name} is blocked`,
      detail: agent.detail,
      action: { label: "Nudge owner", onClick: () => onNotice(`${agent.owner} was asked to unblock ${agent.name}`) },
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

  if (items.length === 0) {
    const working = agents.filter((agent) => agent.status !== "complete").length;
    return (
      <section className="attention" data-empty="true" aria-label="Needs you">
        <div className="attention-heading">
          <strong>Nothing needs you</strong>
        </div>
        <p className="attention-clear">
          <Icon name="check" />
          {working} agents working, no conflicts, all checks green.
        </p>
      </section>
    );
  }

  return (
    <section className="attention" aria-label="Needs you">
      <div className="attention-heading">
        <strong>Needs you</strong>
        <span className="attention-count">{items.length}</span>
      </div>
      <ul className="attention-list">
        {items.map((item) => (
          <li key={item.id} className="attention-item" data-kind={item.kind}>
            <span className="attention-mark">
              <Icon name={marks[item.kind]} />
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
                data-variant={item.action.primary ? "primary" : "quiet"}
                onClick={item.action.onClick}
              >
                {item.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

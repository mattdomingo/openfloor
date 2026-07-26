"use client";

import { ReactNode } from "react";
import { Icon } from "./primitives";
import { PanelId } from "./data";

export type PanelChrome = {
  id: PanelId;
  index: number;
  count: number;
  expanded: boolean;
  collapsible: boolean;
  collapsed: boolean;
  onMove: (direction: -1 | 1) => void;
  onExpand: () => void;
  onCollapse: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
};

export function Panel({
  chrome,
  title,
  meta,
  badge,
  actions,
  footer,
  children,
}: {
  chrome: PanelChrome;
  title: string;
  meta?: string;
  badge?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  if (chrome.collapsed) {
    const atStart = chrome.index === 0;
    return (
      <section className="panel" aria-label={title}>
        <button type="button" className="rail-collapsed" onClick={chrome.onCollapse} title={`Expand ${title}`}>
          <Icon name={atStart ? "chevronRight" : "chevronLeft"} />
          <span className="rail-label">{title}</span>
          {badge && <span className="rail-badge">{badge}</span>}
        </button>
      </section>
    );
  }

  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head" draggable onDragStart={chrome.onDragStart} onDragEnd={chrome.onDragEnd}>
        <div className="panel-title">
          <h2>{title}</h2>
          {meta && <span>{meta}</span>}
        </div>
        <div className="panel-actions">
          {actions}
          <div className="panel-chrome">
            <button type="button" className="grip" title="Drag to reorder" aria-label={`Reorder ${title} panel`}>
              <Icon name="grip" />
            </button>
            <button
              type="button"
              onClick={() => chrome.onMove(-1)}
              disabled={chrome.index === 0}
              title="Move left"
              aria-label={`Move ${title} panel left`}
            >
              <Icon name="arrowLeft" />
            </button>
            <button
              type="button"
              onClick={() => chrome.onMove(1)}
              disabled={chrome.index === chrome.count - 1}
              title="Move right"
              aria-label={`Move ${title} panel right`}
            >
              <Icon name="arrowRight" />
            </button>
            {chrome.collapsible && (
              <button type="button" onClick={chrome.onCollapse} title="Collapse" aria-label={`Collapse ${title} panel`}>
                <Icon name={chrome.index === 0 ? "chevronLeft" : "chevronRight"} />
              </button>
            )}
            <button
              type="button"
              onClick={chrome.onExpand}
              title={chrome.expanded ? "Restore" : "Expand"}
              aria-label={chrome.expanded ? `Restore ${title} panel` : `Expand ${title} panel`}
            >
              <Icon name={chrome.expanded ? "collapse" : "expand"} />
            </button>
          </div>
        </div>
      </div>
      <div className="panel-body">{children}</div>
      {footer && <div className="panel-foot">{footer}</div>}
    </section>
  );
}

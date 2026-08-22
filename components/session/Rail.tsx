"use client";

import { ReactNode } from "react";
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
  actions,
  footer,
  children,
}: {
  chrome: PanelChrome;
  title: string;
  meta?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-head" draggable onDragStart={chrome.onDragStart} onDragEnd={chrome.onDragEnd}>
        <div className="panel-title">
          <h2>{title}</h2>
          {meta && <span>{meta}</span>}
        </div>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      <div className="panel-body">{children}</div>
      {footer && <div className="panel-foot">{footer}</div>}
    </section>
  );
}


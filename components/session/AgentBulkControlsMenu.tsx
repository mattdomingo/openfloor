"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./primitives";

// Owner-only master-control lever over the "any member" per-agent
// pause/stop buttons on AgentCard/AgentSpotlight — see db/floor.ts's
// pauseAllFloorAgents/resumeAllFloorAgents/stopAllFloorAgents. Modeled
// directly on QueueOrderMenu's portaled-dropdown pattern.
export function AgentBulkControlsMenu({ onPauseAll, onResumeAll, onStopAll, busy }: {
  onPauseAll: () => Promise<void>;
  onResumeAll: () => Promise<void>;
  onStopAll: () => Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
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
  }, [open]);

  function run(action: () => Promise<void>) {
    setOpen(false);
    void action();
  }

  const list = open && position && typeof document !== "undefined" && createPortal(
    <div className="queue-order-list" ref={listRef} id={listId} role="group" aria-label="All agents" style={{ top: position.top, right: position.right }}>
      <span className="queue-order-label" aria-hidden="true">All persistent agents</span>
      <ul>
        <li><button type="button" disabled={busy} onClick={() => run(onPauseAll)}><span>Pause all</span><small>Block new dispatch; in-flight runs finish normally</small></button></li>
        <li><button type="button" disabled={busy} onClick={() => run(onResumeAll)}><span>Resume all</span><small>Make every paused agent eligible again</small></button></li>
        <li><button type="button" disabled={busy} onClick={() => run(onStopAll)}><span>Stop all</span><small>Pause every agent and cancel their active runs</small></button></li>
      </ul>
    </div>,
    document.body,
  );

  return (
    <>
      <button type="button" ref={triggerRef} className="queue-order-trigger" aria-label="All-agents controls" aria-expanded={open} aria-controls={listId} title="Pause, resume, or stop every agent" onClick={() => setOpen((current) => !current)}>
        <Icon name="sliders" size={13} />
      </button>
      {list}
    </>
  );
}

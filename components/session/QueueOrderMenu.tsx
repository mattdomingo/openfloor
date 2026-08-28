"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QueueOrderMode } from "./data";
import { Icon } from "./primitives";

const orderOptions: { value: QueueOrderMode; label: string; hint: string }[] = [
  { value: "auto", label: "Saved order", hint: "Use the persisted queue order" },
  { value: "manual", label: "Manual", hint: "Drag to reorder" },
];

export function QueueOrderMenu({
  mode,
  onChange,
  canReorder,
  owner,
  autoDispatch,
  onAutoDispatch,
  autoResolveConflicts,
  onAutoResolveConflicts,
  autoInjectFeedback,
  onAutoInjectFeedback,
  browserConflictAlerts,
  onBrowserConflictAlerts,
  busy,
}: {
  mode: QueueOrderMode;
  onChange: (mode: QueueOrderMode) => void;
  canReorder: boolean;
  owner: boolean;
  autoDispatch: boolean;
  onAutoDispatch: (enabled: boolean) => Promise<void>;
  autoResolveConflicts: boolean;
  onAutoResolveConflicts: (enabled: boolean) => Promise<void>;
  autoInjectFeedback: boolean;
  onAutoInjectFeedback: (enabled: boolean) => Promise<void>;
  browserConflictAlerts: boolean;
  onBrowserConflictAlerts: (enabled: boolean) => Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The dropdown is portaled to <body> so a panel's `overflow: hidden` can't
  // clip it — which also means it's no longer a DOM descendant of the
  // trigger, so the outside-click check needs both refs.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    // Right-anchored (grows leftward from the trigger's right edge) rather
    // than left-anchored: the trigger sits near a panel's right edge, so
    // growing rightward from its left edge can push the list off-screen.
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

  function chooseOrder(next: QueueOrderMode) {
    onChange(next);
    setOpen(false);
  }

  function chooseAutoDispatch(next: boolean) {
    void onAutoDispatch(next);
    setOpen(false);
  }

  function chooseConflictResolution(next: boolean) {
    void onAutoResolveConflicts(next);
    setOpen(false);
  }

  function chooseFeedbackInjection(next: boolean) {
    void onAutoInjectFeedback(next);
    setOpen(false);
  }

  function chooseBrowserAlerts(next: boolean) {
    void onBrowserConflictAlerts(next);
    setOpen(false);
  }

  const list = open && position && typeof document !== "undefined" && createPortal(
    <div className="queue-order-list" ref={listRef} id={listId} role="group" aria-label="Queue settings" style={{ top: position.top, right: position.right }}>
      {owner && (
        <>
          <span className="queue-order-label" aria-hidden="true">
            Auto-dispatch
          </span>
          <ul>
            <li>
              <button
                type="button"
                data-selected={autoDispatch ? "true" : "false"}
                aria-pressed={autoDispatch}
                disabled={busy}
                onClick={() => chooseAutoDispatch(true)}
              >
                <span>On</span>
                <small>openfloor assigns and runs queued prompts automatically</small>
              </button>
            </li>
            <li>
              <button
                type="button"
                data-selected={!autoDispatch ? "true" : "false"}
                aria-pressed={!autoDispatch}
                disabled={busy}
                onClick={() => chooseAutoDispatch(false)}
              >
                <span>Off</span>
                <small>Assign and run queued prompts yourself</small>
              </button>
            </li>
          </ul>
        </>
      )}

      {owner && (
        <>
          <span className="queue-order-label" aria-hidden="true">Merge conflicts</span>
          <ul>
            <li><button type="button" data-selected={autoResolveConflicts ? "true" : "false"} aria-pressed={autoResolveConflicts} disabled={busy} onClick={() => chooseConflictResolution(true)}><span>Automatic</span><small>Prioritize a Merge Resolver when GitHub reports a real conflict</small></button></li>
            <li><button type="button" data-selected={!autoResolveConflicts ? "true" : "false"} aria-pressed={!autoResolveConflicts} disabled={busy} onClick={() => chooseConflictResolution(false)}><span>Manual</span><small>Record conflicts and wait for the owner to start resolution</small></button></li>
          </ul>
        </>
      )}

      {owner && (
        <>
          <span className="queue-order-label" aria-hidden="true">PR feedback</span>
          <ul>
            <li><button type="button" data-selected={autoInjectFeedback ? "true" : "false"} aria-pressed={autoInjectFeedback} disabled={busy} onClick={() => chooseFeedbackInjection(true)}><span>Nudge agents</span><small>Queue CI failures and review comments from the candidate PR for the responsible agent</small></button></li>
            <li><button type="button" data-selected={!autoInjectFeedback ? "true" : "false"} aria-pressed={!autoInjectFeedback} disabled={busy} onClick={() => chooseFeedbackInjection(false)}><span>Skip</span><small>Leave PR feedback for people to relay</small></button></li>
          </ul>
        </>
      )}

      <span className="queue-order-label" aria-hidden="true">This device</span>
      <ul>
        <li><button type="button" data-selected={browserConflictAlerts ? "true" : "false"} aria-pressed={browserConflictAlerts} onClick={() => chooseBrowserAlerts(!browserConflictAlerts)}><span>Browser conflict alerts {browserConflictAlerts ? "on" : "off"}</span><small>Alert this backgrounded floor tab after explicit browser permission</small></button></li>
      </ul>

      {canReorder && (
        <>
          <span className="queue-order-label" aria-hidden="true">
            Ordering
          </span>
          <ul>
            {orderOptions.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  data-selected={mode === option.value ? "true" : "false"}
                  aria-pressed={mode === option.value}
                  onClick={() => chooseOrder(option.value)}
                >
                  <span>{option.label}</span>
                  <small>{option.hint}</small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>,
    document.body,
  );

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="queue-order-trigger"
        aria-label="Queue settings"
        aria-expanded={open}
        aria-controls={listId}
        title={`Queue settings · ${mode === "auto" ? "Auto order" : "Manual order"}${owner ? ` · Auto-dispatch ${autoDispatch ? "on" : "off"}` : ""}`}
        data-active={mode === "manual" || autoDispatch ? "true" : "false"}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="sliders" size={13} />
      </button>
      {list}
    </>
  );
}

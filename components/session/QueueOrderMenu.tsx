"use client";

import { useEffect, useId, useRef, useState } from "react";
import { QueueMergeMode, QueueOrderMode } from "./data";
import { Icon } from "./primitives";

const orderOptions: { value: QueueOrderMode; label: string; hint: string }[] = [
  { value: "auto", label: "Saved order", hint: "Use the persisted queue order" },
  { value: "manual", label: "Manual", hint: "Drag to reorder" },
];

const mergeOptions: { value: QueueMergeMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto-merge", hint: "New prompts fold into the agent's card" },
  { value: "off", label: "Off", hint: "Every prompt keeps its own card" },
];

export function QueueOrderMenu({
  mode,
  onChange,
  mergeMode,
  onMergeMode,
  onMergeNow,
  canReorder,
  owner,
  autoDispatch,
  onAutoDispatch,
  busy,
}: {
  mode: QueueOrderMode;
  onChange: (mode: QueueOrderMode) => void;
  mergeMode: QueueMergeMode;
  onMergeMode: (mode: QueueMergeMode) => void;
  onMergeNow: () => void;
  canReorder: boolean;
  owner: boolean;
  autoDispatch: boolean;
  onAutoDispatch: (enabled: boolean) => Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;

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
  }, [open]);

  function chooseOrder(next: QueueOrderMode) {
    onChange(next);
    setOpen(false);
  }

  function chooseMerge(next: QueueMergeMode) {
    onMergeMode(next);
    setOpen(false);
  }

  function chooseAutoDispatch(next: boolean) {
    void onAutoDispatch(next);
    setOpen(false);
  }

  return (
    <div className="queue-order-menu" ref={rootRef}>
      <button
        type="button"
        className="queue-order-trigger"
        aria-label="Queue settings"
        aria-expanded={open}
        aria-controls={listId}
        title={`Queue settings · ${mode === "auto" ? "Auto order" : "Manual order"} · ${
          mergeMode === "auto" ? "Auto-merge" : "No merging"
        }${owner ? ` · Auto-dispatch ${autoDispatch ? "on" : "off"}` : ""}`}
        data-active={mode === "manual" || mergeMode === "auto" || autoDispatch ? "true" : "false"}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="sliders" size={13} />
      </button>

      {open && (
        <div className="queue-order-list" id={listId} role="group" aria-label="Queue settings">
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

          <span className="queue-order-label" aria-hidden="true">
            Merge prompts
          </span>
          <ul>
            {mergeOptions.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  data-selected={mergeMode === option.value ? "true" : "false"}
                  aria-pressed={mergeMode === option.value}
                  onClick={() => chooseMerge(option.value)}
                >
                  <span>{option.label}</span>
                  <small>{option.hint}</small>
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="queue-order-action"
            onClick={() => {
              onMergeNow();
              setOpen(false);
            }}
          >
            <span>Merge now</span>
            <small>Fold adjacent prompts for the same agent</small>
          </button>
        </div>
      )}
    </div>
  );
}

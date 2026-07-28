"use client";

import { useEffect, useId, useRef, useState } from "react";
import { QueueOrderMode } from "./data";
import { Icon } from "./primitives";

const options: { value: QueueOrderMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "OpenMind orders" },
  { value: "manual", label: "Manual", hint: "Drag to reorder" },
];

export function QueueOrderMenu({ mode, onChange }: { mode: QueueOrderMode; onChange: (mode: QueueOrderMode) => void }) {
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

  function choose(next: QueueOrderMode) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div className="queue-order-menu" ref={rootRef}>
      <button
        type="button"
        className="queue-order-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title={`Queue ordering: ${mode === "auto" ? "Auto" : "Manual"}`}
        data-active={mode === "manual" ? "true" : "false"}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="sliders" size={13} />
      </button>

      {open && (
        <ul className="queue-order-list" id={listId} role="listbox" aria-label="Queue ordering">
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={mode === option.value}>
              <button
                type="button"
                data-selected={mode === option.value ? "true" : "false"}
                onClick={() => choose(option.value)}
              >
                <span>{option.label}</span>
                <small>{option.hint}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

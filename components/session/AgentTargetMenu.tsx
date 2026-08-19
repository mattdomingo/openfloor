"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Agent } from "./data";
import { Icon } from "./primitives";

export function AgentTargetMenu({
  value,
  onChange,
  agents,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  agents: Agent[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = agents.find((agent) => agent.id === value) ?? null;
  const label = selected ? selected.name : "Auto · OpenMind picks";

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

  function choose(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div className="target-menu" ref={rootRef}>
      <button
        type="button"
        className="target-menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
        <Icon name="chevronDown" size={10} />
      </button>

      {open && (
        <ul className="target-menu-list" id={listId} role="listbox" aria-label="Route prompt to">
          <li role="option" aria-selected={value === null}>
            <button type="button" data-selected={value === null ? "true" : "false"} onClick={() => choose(null)}>
              Auto · OpenMind picks
            </button>
          </li>
          {agents.map((agent) => (
            <li key={agent.id} role="option" aria-selected={value === agent.id}>
              <button type="button" data-selected={value === agent.id ? "true" : "false"} onClick={() => choose(agent.id)}>
                {agent.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


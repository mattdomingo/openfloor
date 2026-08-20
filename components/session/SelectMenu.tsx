"use client";

import { KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./primitives";

export type SelectMenuOption = { value: string; label: string; hint?: string };

/* The house replacement for native <select>: a trigger button plus a styled
   listbox, so dropdowns match the floor instead of the operating system.
   Keyboard model is the collapsed-select one — focus stays on the trigger,
   arrows move aria-activedescendant, Enter or Space commits, Escape closes. */
export function SelectMenu({
  value,
  options,
  onChange,
  label,
  disabled,
  align = "down",
}: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  align?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function openMenu() {
    if (options.length === 0) return;
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function choose(next: string) {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (options.length === 0) {
      setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const active = options[activeIndex];
      if (active) choose(active.value);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="select-menu" ref={rootRef} data-align={align} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className="select-menu-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span title={selected?.label || undefined}>{selected?.label ?? (options.length === 0 ? "No options available" : "")}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {open && (
        <ul className="select-menu-list" id={listId} role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              data-selected={option.value === value ? "true" : "false"}
              data-active={index === activeIndex ? "true" : "false"}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(option.value)}
            >
              <span>{option.label}</span>
              {option.hint && <small>{option.hint}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

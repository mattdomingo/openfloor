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
  // Viewport coordinates for the open list. The list renders in-tree (so
  // themed ancestor selectors keep matching) but position: fixed, because an
  // absolutely positioned list clips inside every overflow ancestor — panel
  // chip rows, lobby cards, and .dialog's overflow: hidden all cut it off.
  const [placement, setPlacement] = useState<{ top?: number; bottom?: number; left: number; minWidth: number; up: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    // Fixed coordinates go stale the moment anything scrolls or resizes, so
    // close like a native select instead of chasing the anchor. Capture
    // phase catches inner scroll containers; scrolling the open list itself
    // stays exempt.
    function onScrollOrResize(event: Event) {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  function openMenu() {
    if (options.length === 0) return;
    const trigger = triggerRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      const minWidth = Math.max(rect.width, 170);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - minWidth - 8));
      // 240px list max-height + gap: flip upward when the space below cannot
      // hold the list but the space above can (or the caller pinned "up").
      const spaceBelow = window.innerHeight - rect.bottom;
      const up = align === "up" || (spaceBelow < 250 && rect.top > spaceBelow);
      setPlacement(up
        ? { bottom: window.innerHeight - rect.top + 4, left, minWidth, up }
        : { top: rect.bottom + 4, left, minWidth, up });
    }
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
        <ul
          className="select-menu-list"
          id={listId}
          role="listbox"
          aria-label={label}
          data-flip={placement?.up ? "true" : "false"}
          style={placement ? {
            position: "fixed",
            top: placement.top ?? "auto",
            bottom: placement.bottom ?? "auto",
            left: placement.left,
            minWidth: placement.minWidth,
          } : undefined}
        >
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

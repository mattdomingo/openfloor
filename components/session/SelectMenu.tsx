"use client";

import { KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./primitives";

export type SelectMenuOption = { value: string; label: string; hint?: string };

/* The house replacement for native <select>: a trigger button plus a styled
   listbox, so dropdowns match the floor instead of the operating system.
   Keyboard model is the collapsed-select one — focus stays on the trigger,
   arrows move aria-activedescendant, Enter or Space commits, Escape closes.

   `searchable` adds a filter box inside the popover for lists long enough to
   scroll past (a GitHub account's repositories, a repository's branches). It
   moves focus and the combobox role onto that input while open; without it
   the markup and keyboard model are exactly as they were. */
export function SelectMenu({
  value,
  options,
  onChange,
  label,
  disabled,
  align = "down",
  searchable = false,
}: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  align?: "up" | "down";
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [query, setQuery] = useState("");
  // Viewport coordinates for the open list. The list renders in-tree (so
  // themed ancestor selectors keep matching) but position: fixed, because an
  // absolutely positioned list clips inside every overflow ancestor — panel
  // chip rows, lobby cards, and .dialog's overflow: hidden all cut it off.
  const [placement, setPlacement] = useState<{ top?: number; bottom?: number; left: number; minWidth: number; up: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? null;
  // Everything below indexes into `visible`, which is just `options` unless a
  // filter is actually typed — so the unsearchable path keeps its old
  // behaviour exactly.
  const needle = searchable ? query.trim().toLowerCase() : "";
  const visible = needle
    ? options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(needle))
    : options;

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
    setQuery("");
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }

  function filter(next: string) {
    setQuery(next);
    // The old active row is meaningless against a new result set.
    setActiveIndex(0);
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
    // Space belongs to the filter box while it has focus, or nothing with a
    // space in it could ever be typed.
    if (searchable && event.key === " " && event.target === searchRef.current) return;
    if (visible.length === 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % visible.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + visible.length) % visible.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const active = visible[activeIndex];
      if (active) choose(active.value);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const placementStyle = placement ? {
    position: "fixed" as const,
    top: placement.top ?? "auto",
    bottom: placement.bottom ?? "auto",
    left: placement.left,
    minWidth: placement.minWidth,
  } : undefined;
  const rows = visible.map((option, index) => (
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
  ));

  return (
    <div className="select-menu" ref={rootRef} data-align={align} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className="select-menu-trigger"
        {...(searchable
          // While open the filter box is the combobox, so the trigger must not
          // claim the role (or the active descendant) at the same time.
          ? { "aria-haspopup": "listbox" as const, "aria-expanded": open, "aria-label": label }
          : {
            role: "combobox",
            "aria-haspopup": "listbox" as const,
            "aria-expanded": open,
            "aria-controls": open ? listId : undefined,
            "aria-label": label,
            "aria-activedescendant": open ? `${listId}-${activeIndex}` : undefined,
          })}
        disabled={disabled || options.length === 0}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span title={selected?.label || undefined}>{selected?.label ?? (options.length === 0 ? "No options available" : "")}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {open && !searchable && (
        <ul className="select-menu-list" id={listId} role="listbox" aria-label={label} data-flip={placement?.up ? "true" : "false"} style={placementStyle}>
          {rows}
        </ul>
      )}
      {open && searchable && (
        <div className="select-menu-list select-menu-panel" data-flip={placement?.up ? "true" : "false"} style={placementStyle}>
          <input
            ref={searchRef}
            className="select-menu-search"
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={visible.length > 0 ? `${listId}-${activeIndex}` : undefined}
            aria-label={`Filter ${label.toLowerCase()}`}
            placeholder="Filter…"
            value={query}
            onChange={(event) => filter(event.target.value)}
          />
          <ul className="select-menu-options" id={listId} role="listbox" aria-label={label}>
            {rows}
          </ul>
          {visible.length === 0 && <p className="select-menu-empty" role="status">No matches</p>}
        </div>
      )}
    </div>
  );
}

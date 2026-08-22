"use client";

import { useSyncExternalStore } from "react";

type ThemeMode = "system" | "light" | "polar" | "dark" | "midnight";

const STORAGE_KEY = "openfloor:theme";
const CHANGE_EVENT = "openfloor:theme-change";
const ORDER: ThemeMode[] = ["system", "light", "polar", "dark", "midnight"];
const LABEL: Record<ThemeMode, string> = { system: "System", light: "Light", polar: "Polar", dark: "Dark", midnight: "Midnight" };
const MANUAL_MODES = new Set<ThemeMode>(["light", "polar", "dark", "midnight"]);

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

function readMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && MANUAL_MODES.has(stored as ThemeMode) ? (stored as ThemeMode) : "system";
}

/* Cycles System → Light → Polar → Dark → Midnight. The choice is a per-device
   preference stored in localStorage and applied as html[data-theme];
   app/layout.tsx sets the attribute pre-paint so a saved choice never
   flashes another theme. Polar and Midnight are manual-only variants (no
   prefers-color-scheme tie-in) — System still just follows light/dark. */
export function ThemeToggle() {
  const mode = useSyncExternalStore(subscribe, readMode, () => "system" as ThemeMode);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    if (next === "system") {
      localStorage.removeItem(STORAGE_KEY);
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.dataset.theme = next;
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <button type="button" className="button" data-variant="quiet" onClick={cycle} title={`Theme: ${LABEL[mode]}. Click to change.`} aria-label={`Theme: ${LABEL[mode]}. Activate to change.`}>
      {LABEL[mode]}
    </button>
  );
}

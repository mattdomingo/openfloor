"use client";

import { useState } from "react";
import { BASE_PATH } from "@/components/basePath";

// Per-user, account-wide preference persisted server-side (unlike ThemeToggle,
// which is a per-device localStorage-only choice) — it must stay in sync
// across every session and device the user opens.
//
// Two visual variants share the same fetch/state logic and the same bracket
// button (className="button", styled by .shop-shell .button): "labeled" is
// the compact "DND: On"/"DND: Off" the AccountMenu popover uses, standing on
// its own without a heading; "state" is a bare "On"/"Off", used on the
// Settings page where the row already has its own "Do Not Disturb" title,
// so the button only needs to say which position it's in.
export function DoNotDisturbToggle({ initialValue, variant = "labeled" }: { initialValue: boolean; variant?: "labeled" | "state" }) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !value;
    setValue(next);
    setBusy(true);
    const response = await fetch(`${BASE_PATH}/api/account/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doNotDisturb: next }),
    });
    if (!response.ok) setValue(!next);
    setBusy(false);
  }

  const label = value ? "Do Not Disturb is on. Click to turn off." : "Do Not Disturb is off. Click to turn on.";

  return (
    <button type="button" className="button" data-variant="quiet" aria-pressed={value} disabled={busy} onClick={() => void toggle()} title={label}>
      {variant === "state" ? (value ? "On" : "Off") : (value ? "DND: On" : "DND: Off")}
    </button>
  );
}

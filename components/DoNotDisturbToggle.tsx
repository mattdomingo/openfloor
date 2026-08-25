"use client";

import { useState } from "react";
import { BASE_PATH } from "@/components/basePath";

// Per-user, account-wide preference persisted server-side (unlike ThemeToggle,
// which is a per-device localStorage-only choice) — it must stay in sync
// across every session and device the user opens.
//
// Two visual variants share the same fetch/state logic: "button" is the
// compact bracket button the AccountMenu popover uses alongside its other
// single-line controls; "switch" is a real on/off switch, used on the
// Settings page where the row already carries its own title and
// explanation, so the control only needs to say which position it's in.
export function DoNotDisturbToggle({ initialValue, variant = "button" }: { initialValue: boolean; variant?: "button" | "switch" }) {
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

  if (variant === "switch") {
    return (
      <button type="button" role="switch" className="toggle-switch" aria-checked={value} aria-label="Do Not Disturb" disabled={busy} onClick={() => void toggle()} title={label}>
        <span className="toggle-switch-thumb" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button type="button" className="button" data-variant="quiet" aria-pressed={value} disabled={busy} onClick={() => void toggle()} title={label}>
      {value ? "DND: On" : "DND: Off"}
    </button>
  );
}

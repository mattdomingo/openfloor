"use client";

import { useState } from "react";
import { BASE_PATH } from "@/components/basePath";

// Per-user, account-wide preference persisted server-side (unlike ThemeToggle,
// which is a per-device localStorage-only choice) — it must stay in sync
// across every session and device the user opens.
export function DoNotDisturbToggle({ initialValue }: { initialValue: boolean }) {
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

  return (
    <button
      type="button"
      className="button"
      data-variant="quiet"
      aria-pressed={value}
      disabled={busy}
      onClick={() => void toggle()}
      title={value ? "Do Not Disturb is on. Click to turn off." : "Do Not Disturb is off. Click to turn on."}
    >
      {value ? "DND: On" : "DND: Off"}
    </button>
  );
}

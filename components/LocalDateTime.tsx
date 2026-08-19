"use client";

import { useSyncExternalStore } from "react";
import { formatShortDate, formatShortDateLocal, formatShortTime, formatShortTimeLocal } from "@/lib/date-format";

const emptySubscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/* Timestamps shown to people should read in their own timezone, but server
   markup must stay deterministic (AGENTS.md: hydration and time formatting).
   So the server and the hydration pass emit the UTC form, and the viewer-local
   form replaces it right after mount. */
export function LocalDateTime({ timestamp, mode = "datetime" }: { timestamp: number; mode?: "date" | "time" | "datetime" }) {
  const local = useSyncExternalStore(emptySubscribe, clientSnapshot, serverSnapshot);
  if (mode === "date") return <>{local ? formatShortDateLocal(timestamp) : formatShortDate(timestamp)}</>;
  if (mode === "time") return <>{local ? formatShortTimeLocal(timestamp) : formatShortTime(timestamp)}</>;
  return local
    ? <>{formatShortDateLocal(timestamp)} · {formatShortTimeLocal(timestamp)}</>
    : <>{formatShortDate(timestamp)} · {formatShortTime(timestamp)}</>;
}

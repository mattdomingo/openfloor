"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The dock/status-bar toast used to be a plain useState<string|null> that
// nothing ever set back to null — once any action fired a notice or error,
// .dock-toast rendered forever. This gives it a real lifetime: show()
// replaces the message and arms a dwell timer, then an exit timer matching
// StatusLine's existing (previously dead) exit transition before unmounting.
const DWELL_MS: Record<"notice" | "error", number> = { notice: 3_500, error: 6_000 };
const EXIT_MS = 260; // matches --dur-float in tokens.css

export type NoticeTone = "notice" | "error";

export function useTransientNotice() {
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<NoticeTone>("notice");
  const [visible, setVisible] = useState(false);
  const dwellTimer = useRef<number | null>(null);
  const exitTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (dwellTimer.current) window.clearTimeout(dwellTimer.current);
    if (exitTimer.current) window.clearTimeout(exitTimer.current);
    dwellTimer.current = null;
    exitTimer.current = null;
  }, []);

  const show = useCallback((text: string, nextTone: NoticeTone = "notice") => {
    clearTimers();
    setMessage(text);
    setTone(nextTone);
    setVisible(true);
    dwellTimer.current = window.setTimeout(() => {
      setVisible(false);
      exitTimer.current = window.setTimeout(() => setMessage(null), EXIT_MS);
    }, DWELL_MS[nextTone]);
  }, [clearTimers]);

  const hide = useCallback(() => {
    clearTimers();
    setVisible(false);
    exitTimer.current = window.setTimeout(() => setMessage(null), EXIT_MS);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  return { message, tone, visible, show, hide };
}

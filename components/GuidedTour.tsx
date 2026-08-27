"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/* A step-through tutorial that spotlights real UI (ENG-17). Each step names a
   selector; the bubble sits beside the live element with a highlight ring
   around it, so the tour teaches the actual controls rather than screenshots.
   Portaled to <body> for the same reason HoverTip is (ancestor
   backdrop-filter/transform would break position: fixed).

   Whether it has been seen is per-device localStorage, the same deliberate
   choice as the theme (AGENTS.md "UI state that is intentionally local"): the
   tour auto-opens once per storageKey and never again after Skip/Done. A
   missing anchor (e.g. a control the current role doesn't render) centers the
   bubble instead of crashing the step. */
export type TourStep = { selector: string; title: string; body: string };

function subscribeStorage(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

export function GuidedTour({ storageKey, steps }: { storageKey: string; steps: TourStep[] }) {
  // Same store idiom as ThemeToggle: the server snapshot says "dismissed" so
  // SSR renders nothing, and the first client render opens the tour only when
  // the key is absent. Storage unavailable (private mode) reads as dismissed.
  const dismissed = useSyncExternalStore(
    subscribeStorage,
    () => {
      try {
        return localStorage.getItem(storageKey) != null;
      } catch {
        return true;
      }
    },
    () => true,
  );
  const [closed, setClosed] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const step = !dismissed && !closed ? steps[index] : null;

  useLayoutEffect(() => {
    if (!step) return;
    const measure = () => {
      const element = document.querySelector(step.selector);
      setRect(element ? element.getBoundingClientRect() : null);
    };
    document.querySelector(step.selector)?.scrollIntoView({ block: "nearest" });
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]);

  useEffect(() => {
    if (step) bubbleRef.current?.focus();
  }, [step]);

  if (!step || typeof document === "undefined") return null;

  const finish = () => {
    try {
      localStorage.setItem(storageKey, "done");
    } catch {
      // Without storage the dismissal only lasts this page view.
    }
    setClosed(true);
  };
  const last = index === steps.length - 1;

  // Below the anchor when there's room, above it otherwise; centered when the
  // anchor is missing. Clamped so the bubble never leaves the viewport.
  const bubbleWidth = Math.min(340, window.innerWidth - 24);
  const style = rect
    ? {
        left: Math.max(12, Math.min(rect.left, window.innerWidth - bubbleWidth - 12)),
        top: rect.bottom + 200 < window.innerHeight ? rect.bottom + 12 : Math.max(12, rect.top - 12 - 180),
        width: bubbleWidth,
      }
    : { left: (window.innerWidth - bubbleWidth) / 2, top: window.innerHeight / 3, width: bubbleWidth };

  return createPortal(
    <div className="tour-layer">
      {rect && (
        <div
          className="tour-highlight"
          aria-hidden="true"
          style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      )}
      <div className="tour-bubble" role="dialog" aria-label={step.title} tabIndex={-1} ref={bubbleRef} style={style}>
        <strong>{step.title}</strong>
        <p>{step.body}</p>
        <div className="tour-controls">
          <span className="tour-count">{index + 1} of {steps.length}</span>
          <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={finish}>Skip</button>
          {index > 0 && (
            <button type="button" className="button" data-size="sm" onClick={() => setIndex(index - 1)}>Back</button>
          )}
          <button type="button" className="button" data-variant="primary" data-size="sm" onClick={() => (last ? finish() : setIndex(index + 1))}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/* A step-through tutorial that spotlights real UI (ENG-17). Each step names a
   selector; the bubble sits beside the live element with a highlight ring
   around it, so the tour teaches the actual controls rather than screenshots.
   Steps advance only when the user clicks the highlighted element itself —
   doing the thing is the Next button. Portaled to <body> for the same reason
   HoverTip is (ancestor backdrop-filter/transform would break position:
   fixed).

   Whether it has been seen is per-device localStorage, the same deliberate
   choice as the theme (AGENTS.md "UI state that is intentionally local"): the
   tour auto-opens once per storageKey and never again after Skip/Done. A
   missing anchor (e.g. a control the current role doesn't render) centers the
   bubble instead of crashing the step.

   A step with `isSatisfied` gates on doing the thing instead of merely
   clicking the anchor — filling a field, picking an option, connecting a
   credential. Clicking such a step's anchor no longer advances it (the click
   still reaches the real control normally); once `isSatisfied()` is true,
   Enter advances instead. `isSatisfied` is a plain DOM check, matching
   `selector`, since controlled inputs keep the DOM node's `.value` in sync
   with what's rendered — no need to thread React state out of the form.

   `placement: "side"` opts an anchor into beside-instead-of-below bubble
   placement — for an anchor whose own interaction (e.g. an open dropdown)
   occupies the space directly below it, where the default placement would
   otherwise sit on top of it. */
export type TourStep = { selector: string; title: string; body: string; isSatisfied?: () => boolean; placement?: "side" };

function subscribeStorage(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

// Intersects `rect` with the bounds of the nearest ancestor that actually
// clips overflow, so a tall anchor only partly scrolled into its container
// (e.g. the create dialog's scrolling body) reports only its visible slice —
// not the full, unclipped element, which would otherwise spotlight past the
// scrollport and over whatever sits below it (a pinned footer). Returns null
// when the anchor is fully scrolled out of that container's view.
function clipToScrollableAncestor(rect: DOMRect, element: Element): DOMRect | null {
  let node = element.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      const bounds = node.getBoundingClientRect();
      const top = Math.max(rect.top, bounds.top);
      const bottom = Math.min(rect.bottom, bounds.bottom);
      const left = Math.max(rect.left, bounds.left);
      const right = Math.min(rect.right, bounds.right);
      if (bottom <= top || right <= left) return null;
      return new DOMRect(left, top, right - left, bottom - top);
    }
    node = node.parentElement;
  }
  return rect;
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
  const [satisfied, setSatisfied] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const step = !dismissed && !closed ? steps[index] : null;
  const last = index === steps.length - 1;

  const finish = () => {
    try {
      localStorage.setItem(storageKey, "done");
    } catch {
      // Without storage the dismissal only lasts this page view.
    }
    setClosed(true);
  };

  // The tour advances only when the user clicks the element it is pointing
  // at — doing the thing is the Next button. Capture phase so the advance
  // happens even when the anchor's own handler stops propagation. A gated
  // step (isSatisfied) skips this entirely: the click still reaches the real
  // control, it just isn't the tour's advance gesture — Enter is, below.
  useEffect(() => {
    if (!step || step.isSatisfied) return;
    const onClick = (event: MouseEvent) => {
      const anchor = document.querySelector(step.selector);
      if (!anchor || !(event.target instanceof Node) || !anchor.contains(event.target)) return;
      if (last) {
        try {
          localStorage.setItem(storageKey, "done");
        } catch {
          // Without storage the dismissal only lasts this page view.
        }
        setClosed(true);
      } else {
        setIndex((current) => current + 1);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [step, last, storageKey]);

  // Typing, selecting, or connecting a credential changes an input's .value
  // or a data-* attribute — neither fires the MutationObserver below, so a
  // gated step's "done yet?" hint is driven by a light poll instead.
  useEffect(() => {
    const check = () => setSatisfied(Boolean(step?.isSatisfied?.()));
    check();
    if (!step?.isSatisfied) return;
    const interval = window.setInterval(check, 200);
    return () => window.clearInterval(interval);
  }, [step]);

  // Enter is the gated step's advance gesture. Always preventDefault on
  // Enter while gated — that's what stops the browser's native implicit
  // form-submit from firing early while the tour is walking the form — but
  // never stopPropagation, so SelectMenu's own Enter-to-choose-an-option
  // handling on an open dropdown keeps working. isSatisfied is re-checked
  // directly here rather than trusting the polled state, which can lag by
  // up to one interval tick.
  useEffect(() => {
    if (!step?.isSatisfied) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!step.isSatisfied?.()) return;
      if (last) {
        try {
          localStorage.setItem(storageKey, "done");
        } catch {
          // Without storage the dismissal only lasts this page view.
        }
        setClosed(true);
      } else {
        setIndex((current) => current + 1);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [step, last, storageKey]);

  useLayoutEffect(() => {
    if (!step) return;
    const measure = () => {
      const element = document.querySelector(step.selector);
      // Clipped to the anchor's nearest scrollable ancestor (e.g. the create
      // dialog's scrolling body): a tall section only partly scrolled into
      // view otherwise reports its full, unclipped height, so the highlight
      // and bubble would spill past the visible pane and over whatever sits
      // below it (the dialog's pinned footer buttons). Fully scrolled out of
      // view clips to nothing, same as a missing anchor.
      const next = element ? clipToScrollableAncestor(element.getBoundingClientRect(), element) : null;
      // Same-box check so the MutationObserver below can't re-render forever.
      setRect((current) => {
        if (!next) return null;
        if (current && current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height) return current;
        return next;
      });
    };
    document.querySelector(step.selector)?.scrollIntoView({ block: "nearest" });
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // A step's anchor can render after the step activates — e.g. the create
    // dialog that the previous step's click opens — so watch the DOM too.
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer.disconnect();
    };
  }, [step]);

  useEffect(() => {
    if (step) bubbleRef.current?.focus();
  }, [step]);

  if (!step || typeof document === "undefined") return null;

  // Below the anchor when there's room, above it otherwise; centered when the
  // anchor is missing. Clamped so the bubble never leaves the viewport. A
  // "side" step instead prefers beside the anchor — right first, then left —
  // falling back to the same below/above stacking if neither side fits.
  const bubbleWidth = Math.min(340, window.innerWidth - 24);
  const sideTop = Math.max(12, Math.min(rect?.top ?? 0, window.innerHeight - 200));
  const style = rect
    ? step.placement === "side" && rect.right + 12 + bubbleWidth <= window.innerWidth
      ? { left: rect.right + 12, top: sideTop, width: bubbleWidth }
      : step.placement === "side" && rect.left - 12 - bubbleWidth >= 0
        ? { left: rect.left - 12 - bubbleWidth, top: sideTop, width: bubbleWidth }
        : {
            left: Math.max(12, Math.min(rect.left, window.innerWidth - bubbleWidth - 12)),
            top: rect.bottom + 200 < window.innerHeight ? rect.bottom + 12 : Math.max(12, rect.top - 12 - 180),
            width: bubbleWidth,
          }
    : { left: (window.innerWidth - bubbleWidth) / 2, top: window.innerHeight / 3, width: bubbleWidth };

  // An anchor inside a showModal() dialog lives in the top layer, where a
  // body-portaled bubble would be inert and covered — portal into the dialog.
  const portalTarget = document.querySelector(step.selector)?.closest("dialog[open]") ?? document.body;

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
        {step.isSatisfied ? (satisfied && <p className="tour-hint">Press Enter to continue.</p>) : (rect && <p className="tour-hint">Click the highlighted area to continue.</p>)}
        <div className="tour-controls">
          <span className="tour-count">{index + 1} of {steps.length}</span>
          <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={finish}>Skip</button>
          {/* Only a missing anchor (a control this role doesn't render) gets a
              button to move on — otherwise clicking the real element is the
              only way forward. */}
          {!rect && (
            <button type="button" className="button" data-variant="primary" data-size="sm" onClick={() => (last ? finish() : setIndex(index + 1))}>
              {last ? "Done" : "Next"}
            </button>
          )}
        </div>
      </div>
    </div>,
    portalTarget,
  );
}

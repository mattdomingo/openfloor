"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

// Tour progress is local to this device. Recovery steps restore the actual
// screen before advancing; form steps never simulate a successful mutation.
export type TourStep = {
  selector: string; title: string; body: string;
  isSatisfied?: () => boolean;
  placement?: "side";
  onNext?: () => void;
  waitForAction?: boolean;
  clickSelector?: string;
};

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

export function GuidedTour({ storageKey, steps, recover }: { storageKey: string; steps: TourStep[]; recover?: (index: number) => TourStep | null }) {
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

  const recovery = recover?.(index);
  const step = !dismissed && !closed ? recovery ?? steps[index] : null;
  const last = index === steps.length - 1;

  const finish = useCallback(() => {
    try {
      localStorage.setItem(storageKey, "done");
    } catch {
      // Without storage the dismissal only lasts this page view.
    }
    setClosed(true);
  }, [storageKey]);

  const advance = useCallback((clicked = false) => {
    if (!step || (step.isSatisfied && !step.isSatisfied())) return;
    if (!clicked) step.onNext?.();
    if (recovery || step.waitForAction) return;
    if (last) finish(); else setIndex((current) => current + 1);
  }, [step, recovery, last, finish]);

  useEffect(() => {
    const check = () => setSatisfied(!step?.isSatisfied || step.isSatisfied());
    check();
    if (!step?.isSatisfied) return;
    const interval = window.setInterval(check, 200);
    return () => window.clearInterval(interval);
  }, [step]);

  useEffect(() => {
    if (!step) return;
    const onClick = (event: MouseEvent) => {
      const anchor = document.querySelector(step.clickSelector ?? step.selector);
      if (!anchor || !(event.target instanceof Node) || !anchor.contains(event.target)) return;
      if (!step.isSatisfied) advance(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !step.isSatisfied || step.waitForAction) return;
      // Let an open listbox select its option before advancing the tour.
      if (document.querySelector('[role="listbox"]')) return;
      event.preventDefault();
      advance();
    };
    const onComplete = (event: Event) => {
      if ((event as CustomEvent<string>).detail === storageKey) finish();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("openfloor:tour-complete", onComplete);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("openfloor:tour-complete", onComplete);
    };
  }, [step, advance, storageKey, finish]);

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
        <p className="tour-hint">{recovery ? "Return to the highlighted control to continue." : step.waitForAction ? "Complete this action to finish the tutorial." : step.isSatisfied && !satisfied ? "Complete this step to continue." : "Click Next or use the highlighted control."}</p>
        <div className="tour-controls">
          <span className="tour-count">{index + 1} of {steps.length}</span>
          <button type="button" className="button" data-variant="primary" data-size="sm" disabled={!rect || (Boolean(step.isSatisfied) && !satisfied)} onClick={() => advance()}>
            {last && !recovery ? (step.waitForAction ? "Create session" : "Done") : "Next"}
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}

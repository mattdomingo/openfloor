"use client";

import { useEffect, useRef } from "react";

// Nudges its children toward the cursor via CSS custom properties — a
// lightweight, no-re-render echo of the marketing hero's animated 3D
// diagram, for the faint background texture only.
export function ParallaxLayer({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    function handleMove(event: PointerEvent) {
      el!.style.setProperty("--parallax-x", ((event.clientX / window.innerWidth - 0.5) * 2).toFixed(3));
      el!.style.setProperty("--parallax-y", ((event.clientY / window.innerHeight - 0.5) * 2).toFixed(3));
    }
    window.addEventListener("pointermove", handleMove);
    return () => window.removeEventListener("pointermove", handleMove);
  }, []);

  return (
    <div ref={ref} className="entry-parallax">
      {children}
    </div>
  );
}

"use client";

import { useEffect } from "react";

// The most common way back to this page is the browser's own back button —
// out to Cloudflare Access and back — which Chrome/Safari restore from
// bfcache rather than reloading. A bfcache restore resumes the page exactly
// as it was frozen: already mid- or post-animation, so the load-in sequence
// (entry-fade-in, entry-dot-in, entry-rise-in — every element marked
// entry-anim) never plays. pageshow's persisted flag is what tells a bfcache
// restore apart from a real navigation; forcing each animated element's
// `animation` through `none` and a reflow makes the browser restart it from
// the declared CSS rule, same as a fresh load.
export function EntryReplay() {
  useEffect(() => {
    function replay() {
      document.querySelectorAll<HTMLElement>(".entry-anim").forEach((el) => {
        el.style.animation = "none";
        void el.offsetHeight;
        el.style.animation = "";
      });
    }
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) replay();
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  return null;
}

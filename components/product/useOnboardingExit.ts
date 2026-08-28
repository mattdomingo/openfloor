"use client";

import { useEffect } from "react";
import { BASE_PATH } from "@/components/basePath";

// Flipped just before a navigation onboarding itself initiates that leaves
// the tab (the GitHub App install redirect, an external provider redirect,
// or the finished-setup destination) so the exit tracking below does not
// read that navigation as abandonment.
let trustedExit = false;
export function allowTrustedNavigation() {
  trustedExit = true;
}

// app/onboarding/page.tsx redirects away only once onboardedAt is set, so a
// half-onboarded visitor who reopens /onboarding just re-authenticates the
// same still-live Cloudflare Access session and lands right back here —
// with no way to sign in as a different GitHub account. Leaving the page —
// back button or closing the tab — ends that Access session instead, so the
// next visit starts at sign-in again. See app/signout/route.ts for why both
// the app-domain cookie and the team-domain session need clearing.
// teamLogoutUrl is a server-rendered prop (app/onboarding/page.tsx) and
// never changes for a mounted OnboardingScreen, so it's safe to close over
// in the mount-once effect below rather than track in a ref.
export function useOnboardingExit(teamLogoutUrl: string | null) {
  useEffect(() => {
    trustedExit = false;
    // One sentinel history entry keeps /onboarding one step deep, so the
    // first back press fires `popstate` here instead of leaving the app.
    history.pushState({ onboardingExitGuard: true }, "", window.location.href);

    function onPopState() {
      if (trustedExit) return;
      // A full navigation, not router.push: /signout runs its own document
      // (clears the app cookie, then the team-domain session) and that has
      // to happen in a fresh load, not layered under onboarding's
      // still-mounted React tree.
      window.location.replace(`${BASE_PATH}/signout`);
    }

    function onPageHide() {
      if (trustedExit) return;
      // Best effort: a closed tab (or a typed-URL navigation, which fires
      // no popstate) gets one shot at both logout legs with keepalive so
      // they survive the page unloading. /signout's own inline script
      // never runs here — this isn't a document navigation — so the
      // team-domain leg is fired directly, same request app/signout/route.ts
      // makes from its own script.
      void fetch(`${BASE_PATH}/signout`, { keepalive: true }).catch(() => {});
      if (teamLogoutUrl) {
        void fetch(teamLogoutUrl, { mode: "no-cors", credentials: "include", keepalive: true }).catch(() => {});
      }
    }

    window.addEventListener("popstate", onPopState);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pagehide", onPageHide);
    };
    // Mount-once by design: re-arming per render would replace the sentinel
    // history entry and can race a step change's own history mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

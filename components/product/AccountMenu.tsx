"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DoNotDisturbToggle } from "@/components/DoNotDisturbToggle";
import { Avatar, Icon } from "@/components/session/primitives";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BASE_PATH } from "@/components/basePath";
import { initials } from "@/lib/display-name";
import type { AppUser } from "@/lib/session-types";

/* The account entry point for the whole product: the avatar becomes a real
   button that opens a popover with identity, a link into /home/settings, the
   two account-wide/per-device preference controls, and sign out. Replaces
   the separate copies of ThemeToggle/DoNotDisturbToggle/Sign-out that used
   to live directly in AppHeader and TopBar, and the floor-only
   "Coming soon" SettingsDialog.
   Interaction model follows SelectMenu.tsx: outside pointerdown and Escape
   both close it, and the trigger regains focus on close. */
export function AccountMenu({ user }: { user: AppUser }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // usePathname() excludes basePath, matching what resolveSettingsOrigin
  // (app/home/settings/origin.ts) expects to receive back on `from`.
  const pathname = usePathname();
  const settingsHref = pathname && pathname !== "/home/settings" ? `/home/settings?from=${encodeURIComponent(pathname)}` : "/home/settings";

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="account-menu-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar userId={user.id} initials={initials(user.displayName)} tone="you" version={user.updatedAt} />
      </button>
      {open && (
        <div className="account-menu-panel">
          <div className="account-menu-identity">
            <strong title={user.displayName}>{user.displayName}</strong>
            <span title={user.email}>{user.email}</span>
          </div>
          <Link href={settingsHref} className="account-menu-item" onClick={() => setOpen(false)}>
            Account settings<Icon name="chevronRight" size={12} />
          </Link>
          <div className="account-menu-row">
            <span>Theme</span>
            <ThemeToggle />
          </div>
          <div className="account-menu-row">
            <span>Do Not Disturb</span>
            <DoNotDisturbToggle initialValue={user.doNotDisturb} />
          </div>
          <a className="account-menu-item" href={`${BASE_PATH}/signout`}>Sign out</a>
        </div>
      )}
    </div>
  );
}

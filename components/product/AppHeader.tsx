import Link from "next/link";
import { DoNotDisturbToggle } from "@/components/DoNotDisturbToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Avatar } from "@/components/session/primitives";
import type { AppUser } from "@/lib/session-types";
import { Brand } from "./Brand";

export function AppHeader({ user, sessionTitle }: { user: AppUser; sessionTitle?: string }) {
  return (
    <header className="app-header">
      <Brand />
      {sessionTitle && (
        <nav className="breadcrumbs" aria-label="Session location">
          <Link href="/home">Sessions</Link><span aria-hidden="true">/</span><strong title={sessionTitle}>{sessionTitle}</strong>
        </nav>
      )}
      <div className="account">
        <Avatar userId={user.id} initials={initials(user.displayName)} tone="you" />
        <span className="account-name" title={user.displayName}>{user.displayName}</span>
        <DoNotDisturbToggle initialValue={user.doNotDisturb} />
        <ThemeToggle />
        <a className="button" data-variant="quiet" href="/cdn-cgi/access/logout">Sign out</a>
      </div>
    </header>
  );
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

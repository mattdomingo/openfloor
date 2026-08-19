import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { AppUser } from "@/lib/session-types";
import { Brand } from "./Brand";

export function AppHeader({ user, sessionTitle }: { user: AppUser; sessionTitle?: string }) {
  return (
    <header className="app-header">
      <Brand />
      {sessionTitle && (
        <nav className="breadcrumbs" aria-label="Session location">
          <Link href="/home">Sessions</Link><span aria-hidden="true">/</span><strong>{sessionTitle}</strong>
        </nav>
      )}
      <div className="account">
        <span className="avatar" aria-hidden="true">{initials(user.displayName)}</span>
        <span className="account-name">{user.displayName}</span>
        <ThemeToggle />
        <a className="button" data-variant="quiet" href="/cdn-cgi/access/logout">Sign out</a>
      </div>
    </header>
  );
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

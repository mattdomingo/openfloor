import Link from "next/link";
import type { AppUser } from "@/lib/session-types";
import { AccountMenu } from "./AccountMenu";
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
        <AccountMenu user={user} />
      </div>
    </header>
  );
}

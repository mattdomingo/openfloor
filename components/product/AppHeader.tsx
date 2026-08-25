import Link from "next/link";
import type { AppUser } from "@/lib/session-types";
import { Icon } from "@/components/session/primitives";
import { AccountMenu } from "./AccountMenu";
import { Brand } from "./Brand";

// `backTo` and `sessionTitle` occupy the same slot (both left-align in the
// margin-right:auto position) and are mutually exclusive in practice: the
// breadcrumb names where you already are (session pages), the back link
// names where you'll return to (settings, reached from anywhere). Passing
// both would double up — no caller does.
export function AppHeader({ user, sessionTitle, backTo }: {
  user: AppUser;
  sessionTitle?: string;
  backTo?: { href: string; label: string };
}) {
  return (
    <header className="app-header">
      <Brand />
      {sessionTitle && (
        <nav className="breadcrumbs" aria-label="Session location">
          <Link href="/home">Sessions</Link><span aria-hidden="true">/</span><strong title={sessionTitle}>{sessionTitle}</strong>
        </nav>
      )}
      {backTo && (
        <Link href={backTo.href} className="app-back">
          <Icon name="arrowLeft" size={13} /><span title={backTo.label}>{backTo.label}</span>
        </Link>
      )}
      <div className="account">
        <AccountMenu user={user} />
      </div>
    </header>
  );
}

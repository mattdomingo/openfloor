"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AccountMenu } from "@/components/product/AccountMenu";
import { Brand } from "@/components/product/Brand";
import { formatDuration } from "@/lib/date-format";
import { initials } from "@/lib/display-name";
import type { AppUser, SessionMember, SessionSummary } from "@/lib/session-types";
import { InviteDialog } from "./InviteDialog";
import { Avatar, Icon } from "./primitives";
import type { WorkspaceScreen } from "./data";

/* Active-session-time readout. The server value lags real usage by up to one
   flush interval (ponytail: accepted); while this viewer is connected the
   session is by definition occupied, so the client ticks the display forward
   itself. Ticks re-render only this span, and it is plain text — no aria-live,
   so screen readers are not spammed once a second. */
function SessionTimer({ base, running }: { base: number; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return <span className="session-timer" title="Session time used">{formatDuration(base + elapsed)}</span>;
}

export function TopBar({
  screen,
  onScreen,
  onNotice,
  session,
  user,
  members,
  unreadTeamCount,
  presenceConnected,
}: {
  screen: WorkspaceScreen;
  onScreen: (screen: WorkspaceScreen) => void;
  onNotice: (notice: string) => void;
  session: SessionSummary;
  user: AppUser;
  members: SessionMember[];
  unreadTeamCount: number;
  presenceConnected: boolean;
}) {
  const router = useRouter();
  const [inviting, setInviting] = useState(false);
  const inviteButtonRef = useRef<HTMLButtonElement>(null);

  function closeInvite() {
    setInviting(false);
    inviteButtonRef.current?.focus();
  }

  return (
    <header className="topbar">
      <Brand />

      <div className="history-nav" aria-label="History navigation">
        <button type="button" className="icon-button" aria-label="Go back" title="Go back" onClick={() => router.back()}>
          <Icon name="arrowLeft" />
        </button>
        <button type="button" className="icon-button" aria-label="Go forward" title="Go forward" onClick={() => router.forward()}>
          <Icon name="arrowRight" />
        </button>
      </div>

      <nav className="screen-nav" aria-label="Workspace screens">
        <button type="button" aria-pressed={screen === "workspace"} onClick={() => onScreen("workspace")}>
          Workspace{unreadTeamCount > 0 && <span className="nav-unread-dot" aria-label={`${unreadTeamCount} unread team messages`} />}
        </button>
        <button type="button" aria-pressed={screen === "review"} onClick={() => onScreen("review")}>Review</button>
      </nav>

      <nav className="session-path" aria-label="Session location">
        <Link href="/home">Sessions</Link><span aria-hidden="true">/</span><Link href={`/session/${session.id}`}><strong title={session.title}>{session.title}</strong></Link>
        <span className="live-pill"><Icon name="circle" size={7} />LIVE</span>
        <SessionTimer base={session.activeSeconds} running={presenceConnected && session.endedAt == null} />
      </nav>

      <div className="topbar-actions">
        <div className="presence" aria-label={`${members.filter((member) => member.online).length} people online`}>
          {members.slice(0, 5).map((member, index) => (
            <Avatar key={member.id} userId={member.id} initials={initials(member.displayName)} tone={member.id === user.id ? "you" : `member-${index}`} online={member.online} />
          ))}
        </div>
        {session.role === "owner" && (
          <button type="button" ref={inviteButtonRef} className="button invite-button" onClick={() => setInviting(true)}>
            <Icon name="plus" />Invite
          </button>
        )}
        <AccountMenu user={user} />
      </div>

      {inviting && <InviteDialog session={session} members={members} onNotice={onNotice} onClose={closeInvite} />}
    </header>
  );
}

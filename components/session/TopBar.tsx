"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { initials } from "@/components/product/AppHeader";
import { Brand } from "@/components/product/Brand";
import type { AppUser, SessionMember, SessionSummary } from "@/lib/session-types";
import { InviteDialog } from "./InviteDialog";
import { Avatar, Icon } from "./primitives";
import type { WorkspaceScreen } from "./data";

export function TopBar({
  screen,
  onScreen,
  onNotice,
  session,
  user,
  members,
}: {
  screen: WorkspaceScreen;
  onScreen: (screen: WorkspaceScreen) => void;
  onNotice: (notice: string) => void;
  session: SessionSummary;
  user: AppUser;
  members: SessionMember[];
}) {
  const [inviting, setInviting] = useState(false);
  const inviteButtonRef = useRef<HTMLButtonElement>(null);

  function closeInvite() {
    setInviting(false);
    inviteButtonRef.current?.focus();
  }

  return (
    <header className="topbar">
      <Brand />

      <nav className="screen-nav" aria-label="Workspace screens">
        <button type="button" aria-pressed={screen === "workspace"} onClick={() => onScreen("workspace")}>Workspace</button>
        <button type="button" aria-pressed={screen === "review"} onClick={() => onScreen("review")}>Review</button>
      </nav>

      <nav className="session-path" aria-label="Session location">
        <Link href="/home">Sessions</Link><span aria-hidden="true">/</span><Link href={`/session/${session.id}`}><strong>{session.title}</strong></Link>
        <span className="live-pill"><Icon name="circle" size={7} />LIVE</span>
      </nav>

      <div className="topbar-actions">
        <div className="presence" aria-label={`${members.filter((member) => member.online).length} people online`}>
          {members.slice(0, 5).map((member, index) => (
            <Avatar key={member.id} initials={initials(member.displayName)} tone={member.id === user.id ? "you" : `member-${index}`} online={member.online} />
          ))}
        </div>
        {session.role === "owner" && (
          <button type="button" ref={inviteButtonRef} className="button invite-button" onClick={() => setInviting(true)}>
            <Icon name="plus" />Invite
          </button>
        )}
        <Link className="icon-button" aria-label="Session settings" title="Session settings" href={`/session/${session.id}`}>
          <Icon name="sliders" />
        </Link>
        <ThemeToggle />
        <a className="button" data-variant="quiet" href="/cdn-cgi/access/logout">Sign out</a>
      </div>

      {inviting && <InviteDialog session={session} members={members} onNotice={onNotice} onClose={closeInvite} />}
    </header>
  );
}

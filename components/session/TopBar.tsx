"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
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
      <Link href="/home" className="brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- static product mark */}
        <img className="brand-mark" src={`${BASE_PATH}/openfloor-mark.png`} alt="" aria-hidden="true" />
        OPENFLOOR
      </Link>

      <nav className="screen-nav" aria-label="Workspace screens">
        <button type="button" aria-pressed={screen === "workspace"} onClick={() => onScreen("workspace")}>Workspace</button>
        <button type="button" aria-pressed={screen === "review"} onClick={() => onScreen("review")}>Review</button>
      </nav>

      <nav className="session-path" aria-label="Session location">
        <Link href="/home">Sessions</Link><span aria-hidden="true">/</span><strong>{session.title}</strong>
        <span className="live-pill"><Icon name="circle" size={7} />LIVE</span>
        <span className="prototype-pill">Prototype agent data</span>
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
          <Icon name="more" />
        </Link>
        <a className="button" data-variant="quiet" href="/cdn-cgi/access/logout">Sign out</a>
      </div>

      {inviting && <InviteDialog session={session} members={members} onNotice={onNotice} onClose={closeInvite} />}
    </header>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

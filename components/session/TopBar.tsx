"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { initials } from "@/components/product/AppHeader";
import { Brand } from "@/components/product/Brand";
import type { AppUser, SessionMember, SessionSummary } from "@/lib/session-types";
import { InviteDialog } from "./InviteDialog";
import { SettingsDialog } from "./SettingsDialog";
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
  const router = useRouter();
  const [inviting, setInviting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inviteButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  function closeInvite() {
    setInviting(false);
    inviteButtonRef.current?.focus();
  }

  function closeSettings() {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
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
        <button type="button" aria-pressed={screen === "workspace"} onClick={() => onScreen("workspace")}>Workspace</button>
        <button type="button" aria-pressed={screen === "review"} onClick={() => onScreen("review")}>Review</button>
      </nav>

      <nav className="session-path" aria-label="Session location">
        <Link href="/home">Sessions</Link><span aria-hidden="true">/</span><Link href={`/session/${session.id}`}><strong title={session.title}>{session.title}</strong></Link>
        <span className="live-pill"><Icon name="circle" size={7} />LIVE</span>
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
        <button type="button" ref={settingsButtonRef} className="icon-button" aria-label="Session settings" title="Session settings" onClick={() => setSettingsOpen(true)}>
          <Icon name="sliders" />
        </button>
        <ThemeToggle />
        <a className="button" data-variant="quiet" href="/cdn-cgi/access/logout">Sign out</a>
      </div>

      {inviting && <InviteDialog session={session} members={members} onNotice={onNotice} onClose={closeInvite} />}
      {settingsOpen && <SettingsDialog onClose={closeSettings} />}
    </header>
  );
}

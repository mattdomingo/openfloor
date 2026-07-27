"use client";

import Link from "next/link";
import { participants, WorkspaceScreen } from "./data";
import { Avatar, Icon } from "./primitives";

export function TopBar({
  screen,
  onScreen,
  onNotice,
  sessionTitle,
}: {
  screen: WorkspaceScreen;
  onScreen: (screen: WorkspaceScreen) => void;
  onNotice: (notice: string) => void;
  sessionTitle: string;
}) {
  return (
    <header className="topbar">
      <Link href="/home" className="brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- static mark, no next/image config in this Vite host */}
        <img className="brand-mark" src="/openfloor-mark.png" alt="" aria-hidden="true" />
        OPENFLOOR
      </Link>

      <nav className="screen-nav" aria-label="Workspace screens">
        <button type="button" aria-pressed={screen === "workspace"} onClick={() => onScreen("workspace")}>
          Workspace
        </button>
        <button type="button" aria-pressed={screen === "review"} onClick={() => onScreen("review")}>
          Review
        </button>
      </nav>

      <nav className="session-path" aria-label="Session location">
        <Link href="/home">Sessions</Link>
        <span aria-hidden="true">/</span>
        <strong>{sessionTitle}</strong>
        <span className="live-pill">
          <Icon name="circle" size={7} />
          LIVE
        </span>
      </nav>

      <div className="topbar-actions">
        <div className="presence" aria-label="Participants: Matt, Ryan, and Ali">
          {participants.map((person) => (
            <Avatar key={person.id} initials={person.initials} tone={person.tone} />
          ))}
        </div>
        <button type="button" className="button invite-button" onClick={() => onNotice("Invite link copied to clipboard")}>
          <Icon name="plus" />
          Invite
        </button>
        <button type="button" className="icon-button" aria-label="Session menu">
          <Icon name="more" />
        </button>
      </div>
    </header>
  );
}

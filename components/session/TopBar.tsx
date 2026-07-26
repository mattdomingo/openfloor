"use client";

import { participants, sessionTitle } from "./data";
import { Avatar, Icon } from "./primitives";

export function TopBar({ onNotice }: { onNotice: (notice: string) => void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        OPENFLOOR
      </div>

      <nav className="session-path" aria-label="Session location">
        <span>Sessions</span>
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
        <button type="button" className="button" onClick={() => onNotice("Invite link copied to clipboard")}>
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

"use client";

import { FormEvent } from "react";
import { Draft, participants } from "./data";
import { Avatar, Icon } from "./primitives";

export type LiveDraft = Draft & { visibleText: string };

export function FloorDock({
  value,
  onChange,
  onSubmit,
  onNotice,
  liveDrafts,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onNotice: (notice: string) => void;
  liveDrafts: LiveDraft[];
}) {
  const typingIds = new Set(liveDrafts.map((draft) => draft.id));

  return (
    <section className="dock" aria-label="Open floor">
      <div className="dock-inner">
        <form className="composer" onSubmit={onSubmit}>
          <div className="composer-head">
            <Avatar initials="Y" tone="you" />
            <div className="composer-who">
              <strong>You</strong>
              <span>Dispatch and steer</span>
            </div>
            <div className="floor-presence">
              <span>On the floor</span>
              <div className="presence">
                {participants.map((person) => (
                  <Avatar key={person.id} initials={person.initials} tone={person.tone} typing={typingIds.has(person.id)} />
                ))}
              </div>
            </div>
          </div>

          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Dispatch a task, reply to a teammate, or steer the session…"
            aria-label="Your session message"
          />

          <div className="composer-foot">
            <button type="button" className="button" data-size="sm" data-variant="quiet" onClick={() => onNotice("Attach repository context")}>
              <Icon name="attach" size={12} />
              Attach context
            </button>
            <span>Session context on</span>
            <button type="submit" className="send" aria-label="Send your session message">
              <Icon name="send" />
            </button>
          </div>
        </form>

        {liveDrafts.map((draft) => (
          <div className="lane" key={draft.id} aria-label={`${draft.name} is typing`}>
            <div className="lane-head">
              <Avatar initials={draft.initials} tone={draft.tone} />
              <strong>{draft.name}</strong>
              <em>
                <Icon name="circle" size={6} />
                typing
              </em>
            </div>
            <p>{draft.visibleText}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

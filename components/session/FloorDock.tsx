"use client";

import { FormEvent, useEffect, useRef } from "react";
import { Draft, DockMode, participants } from "./data";
import { Avatar, Icon, SegmentedControl } from "./primitives";

export type FloorLane = Draft & { text: string; typing: boolean };

const dockModeOptions: { value: DockMode; label: string }[] = [
  { value: "focus", label: "Focus" },
  { value: "persistent", label: "Everyone" },
  { value: "live", label: "Typing" },
];

export function FloorDock({
  value,
  onChange,
  onSubmit,
  onNotice,
  dockMode,
  onDockModeChange,
  lanes,
  typingIds,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onNotice: (notice: string) => void;
  dockMode: DockMode;
  onDockModeChange: (mode: DockMode) => void;
  lanes: FloorLane[];
  typingIds: Set<string>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (dockMode === "focus") textareaRef.current?.focus();
  }, [dockMode]);

  return (
    <section className="dock" aria-label="Open floor" data-mode={dockMode}>
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
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Dispatch a task, reply to a teammate, or steer the session…"
            aria-label="Your session message"
          />

          <div className="composer-foot">
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              aria-label="Attach context"
              onClick={() => onNotice("Attach repository context")}
            >
              <Icon name="attach" size={12} />
              <span className="button-label">Attach context</span>
            </button>
            <SegmentedControl label="Teammate drafts" value={dockMode} options={dockModeOptions} onChange={onDockModeChange} />
            <button type="submit" className="send" aria-label="Send your session message">
              <Icon name="send" />
            </button>
          </div>
        </form>

        {dockMode !== "focus" &&
          lanes.map((lane) => (
            <div className="lane" key={lane.id} data-typing={lane.typing ? "true" : "false"} aria-label={lane.typing ? `${lane.name} is typing` : `${lane.name}'s last message`}>
              <div className="lane-head">
                <Avatar initials={lane.initials} tone={lane.tone} typing={lane.typing} />
                <strong>{lane.name}</strong>
                <em>
                  <Icon name="circle" size={6} />
                  {lane.typing ? "typing" : "idle"}
                </em>
              </div>
              <p>{lane.text}</p>
            </div>
          ))}
      </div>
    </section>
  );
}

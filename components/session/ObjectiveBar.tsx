"use client";

import { CSSProperties, useState } from "react";
import { sessionFacts } from "./data";
import { Icon } from "./primitives";

export function ObjectiveBar({
  goal,
  onGoalChange,
  onNotice,
}: {
  goal: string;
  onGoalChange: (goal: string) => void;
  onNotice: (notice: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <section className="objective">
      <div className="objective-main">
        <div className="objective-label">
          <span className="label">Session objective</span>
          <span className="value">Everyone can edit</span>
        </div>
        {editing ? (
          <textarea
            className="objective-input"
            value={goal}
            autoFocus
            aria-label="Session objective"
            onChange={(event) => onGoalChange(event.target.value)}
            onBlur={() => {
              setEditing(false);
              onNotice("Session objective updated for everyone");
            }}
          />
        ) : (
          <h1 className="objective-title">
            <button type="button" className="objective-edit" title="Edit session objective" onClick={() => setEditing(true)}>
              {goal}
            </button>
          </h1>
        )}
      </div>

      <div className="objective-meta">
        <span className="objective-fact">
          <Icon name="branch" />
          {sessionFacts.branch}
        </span>
        <span className="objective-fact">
          <Icon name="clock" />
          {sessionFacts.started}
        </span>
        <div
          className="progress-ring"
          style={{ "--ring-value": `${sessionFacts.progress}%` } as CSSProperties}
          role="img"
          aria-label={`Objective ${sessionFacts.progress} percent complete`}
        >
          <b>{sessionFacts.progress}%</b>
        </div>
      </div>
    </section>
  );
}

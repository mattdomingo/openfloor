"use client";

import { useState } from "react";
import { LocalDateTime } from "@/components/LocalDateTime";
import { OBJECTIVE_NUDGE_THRESHOLD } from "@/lib/floor-state";
import { Icon } from "./primitives";

type SaveState = "idle" | "saving" | "saved" | "error";

export function ObjectiveBar({
  objective,
  updatedAt,
  staleMessageCount = 0,
  isOwner = false,
  onSave,
}: {
  objective: string | null;
  updatedAt: number;
  staleMessageCount?: number;
  isOwner?: boolean;
  onSave: (objective: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(objective ?? "");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [editVersion, setEditVersion] = useState(updatedAt);
  const changedElsewhere = editing && updatedAt > editVersion;

  function beginEditing() {
    setEditVersion(updatedAt);
    setDraft(objective ?? "");
    setSaveState("idle");
    setEditing(true);
  }

  async function save() {
    if (!editing || saveState === "saving") return;
    setSaveState("saving");
    const ok = await onSave(draft.trim() || null);
    if (!ok) {
      setSaveState("error");
      return;
    }
    setSaveState("saved");
    setEditing(false);
  }

  return (
    <section className="objective">
      <div className="objective-main">
        <div className="objective-label">
          <span className="label">Session objective</span>
          <span className="value">Everyone can edit</span>
          {changedElsewhere && <span className="objective-warning">Changed elsewhere · saving will overwrite</span>}
          {saveState === "saving" && <span className="value">Saving…</span>}
          {saveState === "error" && <span className="objective-error" role="alert">Not saved · click away to retry</span>}
        </div>
        {editing ? (
          <textarea
            className="objective-input"
            value={draft}
            autoFocus
            maxLength={2000}
            aria-label="Session objective"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void save();
              }
              if (event.key === "Escape") {
                setDraft(objective ?? "");
                setEditing(false);
              }
            }}
          />
        ) : (
          <h1 className="objective-title">
            <button type="button" className="objective-edit" title="Edit session objective" onClick={beginEditing}>
              {objective || "Add a shared objective for this session"}
            </button>
          </h1>
        )}
      </div>
      <div className="objective-meta">
        <span className="objective-fact"><Icon name="clock" />Updated <LocalDateTime timestamp={updatedAt} mode="time" /></span>
        {isOwner && !editing && staleMessageCount >= OBJECTIVE_NUDGE_THRESHOLD && (
          <span className="objective-nudge" role="status">
            {staleMessageCount} team messages since the objective was last updated.
            <button type="button" className="button" data-size="sm" onClick={beginEditing}>Update objective</button>
          </span>
        )}
      </div>
    </section>
  );
}

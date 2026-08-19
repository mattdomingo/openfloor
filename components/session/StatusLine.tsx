"use client";

import { Icon } from "./primitives";

/* The session's running commentary. It never floats over content: on the
   workspace it has a reserved slot in the dock rail, and the review screen —
   which has no dock — gets the same band of its own. */
export function StatusLine({ notice, visible }: { notice: string; visible: boolean }) {
  return (
    <p className="status-line" role="status" data-visible={visible ? "true" : "false"}>
      <Icon name="circle" size={7} />
      <span>{notice}</span>
    </p>
  );
}

export function StatusBar({ notice, visible }: { notice: string; visible: boolean }) {
  return (
    <div className="status-bar">
      <StatusLine notice={notice} visible={visible} />
    </div>
  );
}


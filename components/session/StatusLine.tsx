"use client";

/* The session's running commentary. It never floats over content: on the
   workspace it has a reserved slot in the dock rail, and the review screen —
   which has no dock — gets the same band of its own. A plain dot + text
   instead of a pill/chip — status you read, not a count or a control. */
export function StatusLine({ notice, visible, tone = "notice" }: { notice: string; visible: boolean; tone?: "notice" | "error" }) {
  return (
    <p className="status-line" role="status" data-visible={visible ? "true" : "false"} data-tone={tone} key={notice}>
      <span className="status-dot" aria-hidden="true" />
      <span title={notice}>{notice}</span>
    </p>
  );
}

export function StatusBar({ notice, visible, tone = "notice" }: { notice: string; visible: boolean; tone?: "notice" | "error" }) {
  return (
    <div className="status-bar">
      <StatusLine notice={notice} visible={visible} tone={tone} />
    </div>
  );
}


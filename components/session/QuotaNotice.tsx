import Link from "next/link";
import { formatDuration } from "@/lib/date-format";
import type { SessionRole } from "@/lib/session-types";

// Shared by the lobby (SessionScreen) and the floor (Workspace) so their
// copy and link cannot drift. Advisory only in both states: for "exhausted"
// the presence gate (close code 4003, worker/presence.ts) is the enforcement
// and this just explains why new connections keep failing; for "low" there is
// nothing to enforce yet — it exists so the ceiling is not a surprise.
export function QuotaNotice({ sessionId, role, remainingSeconds }: {
  sessionId: string;
  role: SessionRole;
  /** Seconds still available, when the plan is inside the warning band. Omit for the exhausted state. */
  remainingSeconds?: number;
}) {
  const low = remainingSeconds != null;
  const owner = role === "owner";
  return (
    <p className="notice" data-tone="attention" role="status">
      {low
        ? `${owner ? "Your plan has" : "Your host's plan has"} ${formatDuration(remainingSeconds)} of monthly session time left. `
        : `${owner
          ? "Your plan's monthly session hours are used up."
          : "Your host has used up their plan's monthly session hours."} New connections are paused until next month. `}
      <Link href={`/home/settings?section=plan&from=${encodeURIComponent(`/session/${sessionId}`)}`}>Upgrade for more session hours</Link>.
    </p>
  );
}

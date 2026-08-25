import Link from "next/link";
import type { SessionRole } from "@/lib/session-types";

// Shared by the lobby (SessionScreen) and the floor (Workspace) so their
// copy and link cannot drift. Advisory only: the presence gate (close code
// 4003, worker/presence.ts) is the enforcement — this just explains why new
// connections keep failing.
export function QuotaNotice({ sessionId, role }: { sessionId: string; role: SessionRole }) {
  return (
    <p className="notice" data-tone="attention" role="status">
      {`${role === "owner"
        ? "Your plan's monthly session hours are used up."
        : "Your host has used up their plan's monthly session hours."} New connections are paused until next month. `}
      <Link href={`/settings?section=plan&from=${encodeURIComponent(`/session/${sessionId}`)}`}>Upgrade for more session hours</Link>.
    </p>
  );
}

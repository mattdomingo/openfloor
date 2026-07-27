export type SessionStatus = "active" | "planned" | "past";

export type SessionParticipant = { initials: string; tone: string };

export type SessionSummary = {
  id: string;
  title: string;
  status: SessionStatus;
  objective: string;
  branch: string;
  updated: string;
  participants: SessionParticipant[];
};

/* Only "realtime-presence" opens the fully detailed mocked workspace — the others
   exist so Home reads like a real dashboard with sessions at every stage. */
export const mockSessions: SessionSummary[] = [
  {
    id: "realtime-presence",
    title: "Realtime presence",
    status: "active",
    objective:
      "Ship realtime presence and agent activity with a shared event model, isolated agent worktrees, and a reviewable combined repository state.",
    branch: "openfloor/session-presence",
    updated: "Active now · 3 people",
    participants: [
      { initials: "M", tone: "matt" },
      { initials: "R", tone: "ryan" },
      { initials: "A", tone: "ali" },
    ],
  },
  {
    id: "billing-retry-queue",
    title: "Billing webhook retries",
    status: "active",
    objective: "Add exponential backoff and a dead-letter queue for failed billing webhook deliveries.",
    branch: "openfloor/billing-retry-queue",
    updated: "Active now · 2 people",
    participants: [
      { initials: "M", tone: "matt" },
      { initials: "R", tone: "ryan" },
    ],
  },
  {
    id: "search-reindex",
    title: "Search reindex pipeline",
    status: "planned",
    objective: "Design a background reindex pipeline that doesn't degrade live search latency.",
    branch: "openfloor/search-reindex",
    updated: "Kickoff scheduled Thursday",
    participants: [{ initials: "A", tone: "ali" }],
  },
  {
    id: "onboarding-checklist",
    title: "Onboarding checklist v2",
    status: "planned",
    objective: "Redesign the first-run checklist to reflect the new workspace layout.",
    branch: "openfloor/onboarding-v2",
    updated: "Starts next week",
    participants: [
      { initials: "R", tone: "ryan" },
      { initials: "A", tone: "ali" },
    ],
  },
  {
    id: "session-refresh-tokens",
    title: "Session refresh tokens",
    status: "past",
    objective: "Replace long-lived session cookies with rotating refresh tokens.",
    branch: "openfloor/session-refresh",
    updated: "Completed 6 days ago",
    participants: [
      { initials: "M", tone: "matt" },
      { initials: "R", tone: "ryan" },
      { initials: "A", tone: "ali" },
    ],
  },
  {
    id: "docs-site-migration",
    title: "Docs site migration",
    status: "past",
    objective: "Move the docs site off the old static generator.",
    branch: "openfloor/docs-migration",
    updated: "Completed 3 weeks ago",
    participants: [{ initials: "A", tone: "ali" }],
  },
];

export function sessionTitleForId(id: string): string {
  return mockSessions.find((session) => session.id === id)?.title ?? "New session";
}

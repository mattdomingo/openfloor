"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { MockUser, clearMockUser } from "@/components/auth/mockAuth";
import { Avatar, Icon } from "@/components/session/primitives";
import { SessionStatus, SessionSummary, mockSessions } from "./data";

const statusLabel: Record<SessionStatus, string> = {
  active: "Active",
  planned: "Planned",
  past: "Past",
};

const statusTone: Record<SessionStatus, string | undefined> = {
  active: "running",
  planned: "review",
  past: undefined,
};

const statusOrder: SessionStatus[] = ["active", "planned", "past"];

export function HomeScreen({ user }: { user: MockUser }) {
  const router = useRouter();

  function logOut() {
    clearMockUser();
    router.replace("/");
  }

  function newSession() {
    router.push(`/session/new-${Date.now()}`);
  }

  return (
    <main className="home-screen">
      <header className="topbar">
        <Link href="/home" className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element -- static mark, no next/image config in this Vite host */}
          <img className="brand-mark" src="/app/openfloor-mark.png" alt="" aria-hidden="true" />
          OPENFLOOR
        </Link>

        <div className="topbar-actions">
          <span className="home-user">
            Signed in as <strong>{user.name}</strong>
          </span>
          <button type="button" className="button" data-variant="quiet" onClick={logOut}>
            Log out
          </button>
          <button type="button" className="button" data-variant="primary" onClick={newSession}>
            <Icon name="plus" size={12} />
            New session
          </button>
        </div>
      </header>

      <div className="home-body">
        <div className="home-intro">
          <h1>Your sessions</h1>
          <p>Everything you&apos;re coordinating with your team and its agents.</p>
        </div>

        {statusOrder.map((status) => {
          const sessions = mockSessions.filter((session) => session.status === status);
          if (sessions.length === 0) return null;

          return (
            <section className="home-group" key={status}>
              <div className="home-group-head">
                <h2>{statusLabel[status]}</h2>
                <span>{sessions.length}</span>
              </div>
              <div className="home-grid">
                {sessions.map((session) => (
                  <SessionCard key={session.id} session={session} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

function SessionCard({ session }: { session: SessionSummary }) {
  return (
    <Link href={`/session/${session.id}`} className="session-card">
      <div className="session-card-head">
        <strong>{session.title}</strong>
        <span className="state-tag" data-tone={statusTone[session.status]}>
          {statusLabel[session.status]}
        </span>
      </div>
      <p>{session.objective}</p>
      <div className="session-card-foot">
        <div className="presence">
          {session.participants.map((person, index) => (
            <Avatar key={index} initials={person.initials} tone={person.tone} />
          ))}
        </div>
        <span className="value">{session.branch}</span>
      </div>
      <span className="session-card-updated">{session.updated}</span>
    </Link>
  );
}

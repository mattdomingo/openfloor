"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { formatShortDate } from "@/lib/date-format";
import type { AppUser, SessionSummary } from "@/lib/session-types";
import { AppHeader } from "./AppHeader";

export function HomeScreen({ user, sessions }: { user: AppUser; sessions: SessionSummary[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const response = await fetch(`${BASE_PATH}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, objective }),
    });
    const body = (await response.json()) as { session?: SessionSummary; error?: string };
    if (!response.ok || !body.session) {
      setError(body.error ?? "Unable to create the session.");
      setSubmitting(false);
      return;
    }
    router.push(`/session/${body.session.id}`);
  }

  return (
    <main className="product-shell">
      <AppHeader user={user} />
      <section className="page-body">
        <div className="page-heading">
          <div><p className="eyebrow">Workspace</p><h1>Your sessions</h1><p>Durable rooms for the people doing the work.</p></div>
          <button className="button" data-variant="primary" onClick={() => setCreating((value) => !value)}>
            {creating ? "Cancel" : "New session"}
          </button>
        </div>

        {creating && (
          <form className="create-card" onSubmit={create}>
            <label><span>Session title</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} required autoFocus /></label>
            <label><span>Objective <em>optional</em></span><textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={2000} rows={3} /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="form-actions"><button className="button" data-variant="primary" disabled={submitting}>{submitting ? "Creating…" : "Create session"}</button></div>
          </form>
        )}

        {sessions.length === 0 ? (
          <div className="empty-state"><strong>No sessions yet</strong><p>Create a room, then invite the people working beside you.</p></div>
        ) : (
          <div className="session-grid">
            {sessions.map((session) => (
              <a className="session-card" href={`${BASE_PATH}/session/${session.id}`} key={session.id}>
                <div className="session-card-head"><strong>{session.title}</strong><span className="role-pill">{session.role}</span></div>
                <p>{session.objective || "No objective has been written yet."}</p>
                <div className="session-card-foot"><span>{session.memberCount} {session.memberCount === 1 ? "member" : "members"}</span><time>{formatShortDate(session.updatedAt)}</time></div>
              </a>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

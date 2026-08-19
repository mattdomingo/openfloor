"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { useDialogDismiss } from "@/components/session/primitives";
import type { AppUser, SessionSummary } from "@/lib/session-types";
import { AppHeader } from "./AppHeader";

export function HomeScreen({ user, sessions }: { user: AppUser; sessions: SessionSummary[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const activeSessions = sessions.filter((session) => session.endedAt == null);
  const endedSessions = sessions.filter((session) => session.endedAt != null);

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
          <>
            {activeSessions.length > 0 && (
              <>
                {endedSessions.length > 0 && <h2 className="session-group-heading">Active</h2>}
                <SessionGrid sessions={activeSessions} onDelete={setPendingDelete} />
              </>
            )}
            {endedSessions.length > 0 && (
              <>
                <h2 className="session-group-heading">Ended</h2>
                <SessionGrid sessions={endedSessions} onDelete={setPendingDelete} />
              </>
            )}
          </>
        )}
      </section>
      {pendingDelete && <DeleteSessionDialog session={pendingDelete} onClose={() => setPendingDelete(null)} />}
    </main>
  );
}

function SessionGrid({ sessions, onDelete }: { sessions: SessionSummary[]; onDelete: (session: SessionSummary) => void }) {
  return (
    <div className="session-grid">
      {sessions.map((session) => (
        <div className="session-card" key={session.id}>
          <div className="session-card-head">
            {/* The link stays on the title text so tests and readers keep one obvious target. */}
            <a className="session-card-link" href={`${BASE_PATH}/session/${session.id}`}><strong>{session.title}</strong></a>
            <span className="session-card-pills">{session.endedAt != null && <span className="role-pill">Ended</span>}<span className="role-pill">{session.role}</span></span>
          </div>
          <p>{session.objective || "No objective has been written yet."}</p>
          <div className="session-card-foot">
            <span>{session.memberCount} {session.memberCount === 1 ? "member" : "members"}</span>
            <span className="session-card-foot-end">
              {session.role === "owner" && <button type="button" className="button danger-button" data-size="sm" onClick={() => onDelete(session)}>Delete</button>}
              <time><LocalDateTime timestamp={session.updatedAt} mode="date" /></time>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DeleteSessionDialog({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const router = useRouter();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Unable to delete the session");
      setBusy(false);
      return;
    }
    dismiss();
    router.refresh();
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="delete-session-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="delete-session-title">Delete “{session.title}”?</h2><p>This permanently removes the session for every member: floor, queue, messages, and repository connection. It cannot be undone.</p></div>
      </div>
      {error && <div className="dialog-body"><p className="form-error" role="alert">{error}</p></div>}
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        <button type="button" className="button danger-button" onClick={remove} disabled={busy}>Delete session</button>
      </div>
    </dialog>
  );
}

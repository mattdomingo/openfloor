"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { formatDuration } from "@/lib/date-format";
import { SegmentedControl, useDialogDismiss } from "@/components/session/primitives";
import { planLabel, type Plan, type PlanStatus } from "@/lib/plans";
import type { AppUser, SessionSummary } from "@/lib/session-types";
import { WaveField } from "@/app/entry-wave";
import { AppHeader } from "./AppHeader";

type SessionTab = "active" | "archived" | "ended";
type Usage = { plan: Plan; planStatus: PlanStatus; effectivePlan: Plan; seconds: number; limitHours: number; limitSeats: number };

export function HomeScreen({
  user,
  sessions: initialSessions,
  usage,
}: {
  user: AppUser;
  sessions: SessionSummary[];
  usage: Usage;
}) {
  const router = useRouter();
  const [sessions, setSessions] = useState(initialSessions);
  // router.refresh() (after delete) re-renders this Server Component prop without
  // remounting HomeScreen, so local state needs to resync — done during render,
  // React's documented pattern, rather than in an effect (avoids an extra render).
  const [syncedSessions, setSyncedSessions] = useState(initialSessions);
  if (syncedSessions !== initialSessions) {
    setSyncedSessions(initialSessions);
    setSessions(initialSessions);
  }
  const [tab, setTab] = useState<SessionTab>("active");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  // The removal close code (4005) fires while the removed member is still on
  // the session or floor page, which navigates here before this component
  // mounts — sessionStorage is the only way to carry the reason across that
  // navigation. A lazy initializer (not an effect) reads and clears it
  // exactly once so a later reload never resurfaces a stale notice.
  const [removedNotice, setRemovedNotice] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = sessionStorage.getItem("openfloor:removed-notice");
    if (stored) sessionStorage.removeItem("openfloor:removed-notice");
    return stored;
  });
  const activeSessions = sessions.filter((session) => session.archivedAt == null && session.endedAt == null);
  const archivedSessions = sessions.filter((session) => session.archivedAt != null);
  const endedSessions = sessions.filter((session) => session.archivedAt == null && session.endedAt != null);
  const tabSessions = tab === "active" ? activeSessions : tab === "archived" ? archivedSessions : endedSessions;
  // Hours are metered per session and summed onto one monthly total, so two
  // live owned sessions burn the month at twice wall-clock — worth calling
  // out explicitly, or it reads as a billing bug rather than the chosen
  // (and documented) behavior.
  const liveOwnedSessions = sessions.filter((session) => session.role === "owner" && session.endedAt == null).length;
  const quotaExhausted = Number.isFinite(usage.limitHours) && usage.seconds >= usage.limitHours * 3600;
  const usageLimitSeconds = usage.limitHours * 3600;
  const usagePercent = Number.isFinite(usage.limitHours) ? Math.min(100, Math.round((usage.seconds / usageLimitSeconds) * 100)) : null;
  // One computed string, not several adjacent JSX expressions: React SSR
  // inserts an <!-- --> hydration-boundary comment between adjacent text
  // nodes, which would otherwise split "Free plan" across a comment.
  const usageLine = `${planLabel(usage.effectivePlan)} plan · ${
    Number.isFinite(usage.limitHours)
      ? `${formatDuration(usage.seconds)} of ${usage.limitHours}h session time used this month (UTC)`
      : `${formatDuration(usage.seconds)} session time used this month (UTC)`
  }${liveOwnedSessions > 1 ? ` · ${liveOwnedSessions} live sessions, all counting toward your usage` : ""}`;

  async function setArchived(session: SessionSummary, archived: boolean) {
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/${archived ? "archive" : "unarchive"}`, { method: "POST" });
    if (!response.ok) return;
    setSessions((current) =>
      current.map((entry) => (entry.id === session.id ? { ...entry, archivedAt: archived ? Date.now() : null } : entry)),
    );
  }

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
    <main className="product-shell shop-shell">
      <WaveField varName="--wave" className="shop-wave" />
      <AppHeader user={user} />
      <section className="page-body">
        <div className="page-heading">
          <div>
            <h1>Your sessions</h1>
            <div className="usage-panel">
              {usagePercent != null && (
                <progress className="usage-meter" value={Math.min(usage.seconds, usageLimitSeconds)} max={usageLimitSeconds} aria-label={`${usagePercent}% of monthly session time used`} />
              )}
              <p className="usage-line">{usageLine}</p>
            </div>
            {removedNotice && (
              <p className="notice" data-tone="attention" role="status">
                {removedNotice} <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => setRemovedNotice(null)}>Dismiss</button>
              </p>
            )}
            {quotaExhausted && (
              /* Advisory only, same as the ended-session banner in
                 Workspace.tsx: the 403s on create/dispatch are the
                 enforcement. */
              <p className="notice" data-tone="attention" role="status">
                {`Your ${planLabel(usage.effectivePlan)} plan's ${usage.limitHours}h of monthly session time is used up. `}
                <Link href="/settings?section=plan">Upgrade for more session hours</Link>.
              </p>
            )}
          </div>
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
          <div className="empty-state"><strong>No sessions yet</strong><p>Create a session, then invite the people working beside you.</p></div>
        ) : (
          <>
            <SegmentedControl
              label="Filter sessions"
              value={tab}
              onChange={setTab}
              options={[
                { value: "active", label: `Active (${activeSessions.length})` },
                { value: "archived", label: `Archived (${archivedSessions.length})` },
                { value: "ended", label: `Ended (${endedSessions.length})` },
              ]}
            />
            {tabSessions.length === 0 ? (
              <div className="empty-state">
                <strong>Nothing here</strong>
                <p>{tab === "active" && "Sessions you archive or end will move out of this tab."}
                  {tab === "archived" && "Archive a session from Active or Ended to tuck it out of your own view."}
                  {tab === "ended" && "Sessions the owner ends will show up here."}</p>
              </div>
            ) : (
              <SessionGrid sessions={tabSessions} archived={tab === "archived"} onDelete={setPendingDelete} onSetArchived={setArchived} limitSeats={usage.limitSeats} />
            )}
          </>
        )}
      </section>
      {pendingDelete && <DeleteSessionDialog session={pendingDelete} onClose={() => setPendingDelete(null)} />}
    </main>
  );
}

function SessionGrid({
  sessions,
  archived,
  onDelete,
  onSetArchived,
  limitSeats,
}: {
  sessions: SessionSummary[];
  archived: boolean;
  onDelete: (session: SessionSummary) => void;
  onSetArchived: (session: SessionSummary, archived: boolean) => void;
  limitSeats: number;
}) {
  return (
    <div className="session-grid">
      {sessions.map((session) => {
        // Ledger row: title + actions, then one mono meta line carrying every
        // machine value that used to be split across pills and the foot row,
        // then the objective — the site's own .study idiom (rule-separated
        // rows, tracked-mono data line) rather than a boxed card.
        const seatsOrMembers =
          session.role === "owner" && Number.isFinite(limitSeats)
            ? `${session.memberCount} of ${limitSeats} seats`
            : `${session.memberCount} ${session.memberCount === 1 ? "member" : "members"}`;
        return (
          <div className="session-card" key={session.id}>
            <div className="session-card-head">
              {/* The link stays on the title text so tests and readers keep one obvious target. */}
              <Link className="session-card-link" href={`/session/${session.id}`}><strong>{session.title}</strong></Link>
              <span className="session-card-foot-end">
                <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => onSetArchived(session, !archived)}>{archived ? "Unarchive" : "Archive"}</button>
                {session.role === "owner" && <button type="button" className="button danger-button" data-size="sm" onClick={() => onDelete(session)}>Delete</button>}
              </span>
            </div>
            <p className="session-card-meta">
              <span className="role-pill">{session.role}</span>
              {session.endedAt != null && <span className="role-pill"> · Ended</span>}
              {` · ${seatsOrMembers} · ${formatDuration(session.activeSeconds)} active · Updated `}
              <LocalDateTime timestamp={session.updatedAt} mode="date" />
            </p>
            <p>{session.objective || "No objective has been written yet."}</p>
          </div>
        );
      })}
    </div>
  );
}

function DeleteSessionDialog({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const router = useRouter();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [blockingRunId, setBlockingRunId] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; runId?: string } | null;
      setError(body?.error ?? "Unable to delete the session");
      setBlockingRunId(body?.runId ?? null);
      setBusy(false);
      return;
    }
    const body = (await response.json().catch(() => null)) as { warning?: string } | null;
    if (body?.warning) {
      setWarning(body.warning);
      setBusy(false);
      router.refresh();
      return;
    }
    dismiss();
    router.refresh();
  }

  async function cancelAndRetry() {
    if (!blockingRunId) return;
    setBusy(true);
    setError(null);
    await fetch(`${BASE_PATH}/api/sessions/${session.id}/runs/${encodeURIComponent(blockingRunId)}/cancel`, { method: "POST" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}`, { method: "DELETE" });
      if (response.ok) {
        setBlockingRunId(null);
        const body = (await response.json().catch(() => null)) as { warning?: string } | null;
        if (body?.warning) {
          setWarning(body.warning);
          setBusy(false);
        } else {
          dismiss();
        }
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string; runId?: string } | null;
      if (!body?.runId) {
        setError(body?.error ?? "Unable to delete the session");
        setBlockingRunId(null);
        setBusy(false);
        return;
      }
    }
    setError("The run is taking longer than expected to cancel. Try again in a moment.");
    setBusy(false);
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="delete-session-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="delete-session-title">Delete “{session.title}”?</h2><p>This permanently removes the session for every member: floor, queue, messages, and repository connection. It cannot be undone.</p></div>
      </div>
      {error && <div className="dialog-body"><p className="form-error" role="alert">{error}</p></div>}
      {warning && <div className="dialog-body"><p role="status">Session deleted. {warning}</p></div>}
      <div className="dialog-foot">
        {warning ? (
          <button type="button" className="button" onClick={dismiss}>Close</button>
        ) : (
          <>
            <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
            {blockingRunId ? (
              <button type="button" className="button danger-button" onClick={cancelAndRetry} disabled={busy}>Cancel that run &amp; delete session</button>
            ) : (
              <button type="button" className="button danger-button" onClick={remove} disabled={busy}>Delete session</button>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

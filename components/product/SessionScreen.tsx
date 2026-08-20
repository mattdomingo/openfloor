"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { useDialogDismiss } from "@/components/session/primitives";
import { reducePresence } from "@/lib/presence";
import type { AppUser, PresenceEvent, RepositoryCandidate, RepositoryConnection, RepositoryPreflight, SessionMember, SessionSummary } from "@/lib/session-types";
import { AppHeader, initials } from "./AppHeader";
import { RepositoryCard } from "./RepositoryCard";

type ConnectionState = "connecting" | "connected" | "reconnecting";

export function SessionScreen({
  user,
  session,
  initialMembers,
  initialRepository,
  initialCandidate,
  initialPreflight,
  preflightEnabled,
  githubSetup,
}: {
  user: AppUser;
  session: SessionSummary;
  initialMembers: SessionMember[];
  initialRepository: RepositoryConnection | null;
  initialCandidate: RepositoryCandidate | null;
  initialPreflight: RepositoryPreflight | null;
  preflightEnabled: boolean;
  githubSetup: boolean;
}) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [inviteUrl, setInviteUrl] = useState<string | null | undefined>(undefined);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const retryRef = useRef(0);
  const endedAt = session.endedAt;

  const refreshMembers = useCallback(async () => {
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/members`, { cache: "no-store" });
    if (response.status === 404) {
      router.replace("/home");
      return;
    }
    if (!response.ok) return;
    const body = (await response.json()) as { members: SessionMember[] };
    setMembers(body.members);
  }, [router, session.id]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;
      setConnection(retryRef.current === 0 ? "connecting" : "reconnecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}${BASE_PATH}/api/sessions/${session.id}/presence`);
      socket.addEventListener("open", () => {
        retryRef.current = 0;
        setConnection("connected");
      });
      socket.addEventListener("message", (message) => {
        let event: PresenceEvent;
        try {
          event = JSON.parse(String(message.data)) as PresenceEvent;
        } catch {
          return;
        }
        if (event.type === "presence.snapshot" || event.type === "presence.changed") {
          setOnlineIds((current) => reducePresence(current, event));
        }
        if (event.type === "members.changed") void refreshMembers();
        if (event.type === "session.ended") router.refresh();
        if (event.type === "floor.changed" && event.domains.some((domain) => domain === "repository" || domain === "review")) router.refresh();
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        retryRef.current += 1;
        setConnection("reconnecting");
        const delay = Math.min(10_000, 500 * 2 ** Math.min(retryRef.current - 1, 5));
        retryTimer = window.setTimeout(connect, delay);
      });
    }

    connect();
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close(1000, "Session page closed");
    };
  }, [refreshMembers, router, session.id]);

  useEffect(() => {
    if (session.role !== "owner") return;
    void fetch(`${BASE_PATH}/api/sessions/${session.id}/invite`, { cache: "no-store" })
      .then((response) => response.json() as Promise<{ inviteUrl: string | null }>)
      .then((body: { inviteUrl: string | null }) => setInviteUrl(body.inviteUrl));
  }, [session.id, session.role]);

  const visibleMembers = useMemo(
    () => members.map((member) => ({ ...member, online: onlineIds.has(member.id) })),
    [members, onlineIds],
  );
  const onlineCount = visibleMembers.filter((member) => member.online).length;

  async function rotateInvite() {
    setInviteBusy(true);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/invite`, { method: "POST" });
    const body = (await response.json()) as { inviteUrl?: string };
    setInviteUrl(body.inviteUrl ?? null);
    setInviteBusy(false);
    setNotice("A new invite link is active. The previous link no longer works.");
  }

  async function revokeInviteLink() {
    setInviteBusy(true);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/invite`, { method: "DELETE" });
    if (response.ok) {
      setInviteUrl(null);
      setNotice("Invite link revoked.");
    }
    setInviteBusy(false);
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setNotice("Invite link copied.");
  }

  async function leave() {
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/membership`, { method: "DELETE" });
    if (!response.ok) return;
    router.replace("/home");
  }

  return (
    <main className="product-shell">
      <AppHeader user={user} sessionTitle={session.title} />
      <section className="session-hero">
        <div><p className="eyebrow">{endedAt != null ? "Ended session" : "Live session"}</p><h1>{session.title}</h1><p>{session.objective || "No objective has been written yet."}</p></div>
        <div className="session-hero-actions">
          <div className="connection-state" data-state={connection}><span aria-hidden="true" />{connection === "connected" ? `${onlineCount} online` : connection}</div>
          <Link className="button" data-variant="primary" data-size="lg" href={`/session/${session.id}/floor`}>Enter agent floor</Link>
        </div>
      </section>

      <section className="session-layout">
        <div className="member-panel">
          <div className="panel-heading"><div><p className="eyebrow">People</p><h2>Session members</h2></div><span>{members.length}</span></div>
          <ul className="member-list">
            {visibleMembers.map((member) => (
              <li key={member.id}>
                <span className="avatar" aria-hidden="true">{initials(member.displayName)}</span>
                <div><strong title={member.displayName}>{member.displayName}{member.id === user.id && <em> You</em>}</strong><span>Joined <LocalDateTime timestamp={member.joinedAt} mode="date" /></span></div>
                <span className="member-role">{member.role}</span>
                <span className="presence-label" data-online={member.online}>{member.online ? "Online" : "Offline"}</span>
              </li>
            ))}
          </ul>
        </div>

        <aside className="session-actions">
          {endedAt != null && (
            <section className="action-card quiet-card">
              <p className="eyebrow">Session ended</p>
              <p>
                {session.endedReason === "merged"
                  ? <>This session ended <LocalDateTime timestamp={endedAt} mode="date" /> because the candidate branch was merged.</>
                  : <>This session ended <LocalDateTime timestamp={endedAt} mode="date" />.</>} The floor is read-only and the invite link is revoked.
              </p>
            </section>
          )}
          {session.role === "owner" ? (
            endedAt == null && (
              <>
                <section className="action-card">
                  <p className="eyebrow">Invite people</p><h2>Bring your team in</h2><p>The active link is reusable until you rotate or revoke it.</p>
                  {inviteUrl ? <input className="invite-value" value={inviteUrl} readOnly onFocus={(event) => event.currentTarget.select()} aria-label="Active invite link" /> : <div className="invite-empty">No active invite link.</div>}
                  <div className="button-row">
                    {inviteUrl && <button className="button" data-variant="primary" onClick={copyInvite}>Copy link</button>}
                    <button className="button" onClick={rotateInvite} disabled={inviteBusy}>{inviteUrl ? "Rotate" : "Create link"}</button>
                    {inviteUrl && <button className="button danger-button" onClick={revokeInviteLink} disabled={inviteBusy}>Revoke</button>}
                  </div>
                </section>
                <section className="action-card">
                  <p className="eyebrow">Wrap up</p><h2>End this session</h2><p>Ends it for everyone: the floor becomes read-only and the invite link stops working. Nothing is deleted.</p>
                  <button className="button danger-button" onClick={() => setEnding(true)}>End session</button>
                </section>
              </>
            )
          ) : (
            <section className="action-card"><p className="eyebrow">Membership</p><h2>Your membership</h2><p>Leaving removes this session from your home and ends your live connection.</p><button className="button danger-button" onClick={leave}>Leave session</button></section>
          )}
          {endedAt == null && <RepositoryCard sessionId={session.id} sessionTitle={session.title} sessionObjective={session.objective} role={session.role} initialRepository={initialRepository} initialCandidate={initialCandidate} initialPreflight={initialPreflight} preflightEnabled={preflightEnabled} beginSetup={githubSetup} />}
          <section className="action-card quiet-card"><p className="eyebrow">Saved automatically</p><p>The session, its objective, members, and invite state are stored. Presence shows who is connected right now.</p></section>
          {notice && <p className="notice" role="status">{notice}</p>}
        </aside>
      </section>
      {ending && <EndSessionDialog sessionId={session.id} onClose={() => setEnding(false)} />}
    </main>
  );
}

function EndSessionDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const router = useRouter();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockingRunId, setBlockingRunId] = useState<string | null>(null);

  async function end() {
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/end`, { method: "POST" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; runId?: string } | null;
      setError(body?.error ?? "Unable to end the session");
      setBlockingRunId(body?.runId ?? null);
      setBusy(false);
      return;
    }
    dismiss();
    router.refresh();
  }

  async function cancelAndRetry() {
    if (!blockingRunId) return;
    setBusy(true);
    setError(null);
    await fetch(`${BASE_PATH}/api/sessions/${sessionId}/runs/${encodeURIComponent(blockingRunId)}/cancel`, { method: "POST" });
    // The workflow only notices cancellation between retry attempts, so give
    // it a few chances to actually release the candidate before giving up.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/end`, { method: "POST" });
      if (response.ok) {
        setBlockingRunId(null);
        dismiss();
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string; runId?: string } | null;
      if (!body?.runId) {
        setError(body?.error ?? "Unable to end the session");
        setBlockingRunId(null);
        setBusy(false);
        return;
      }
    }
    setError("The run is taking longer than expected to cancel. Try again in a moment.");
    setBusy(false);
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="end-session-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="end-session-title">End this session?</h2><p>The floor becomes read-only for everyone and the invite link stops working. Nothing is deleted.</p></div>
      </div>
      {error && <div className="dialog-body"><p className="form-error" role="alert">{error}</p></div>}
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        {blockingRunId ? (
          <button type="button" className="button danger-button" onClick={cancelAndRetry} disabled={busy}>Cancel that run &amp; end session</button>
        ) : (
          <button type="button" className="button danger-button" onClick={end} disabled={busy}>End session</button>
        )}
      </div>
    </dialog>
  );
}

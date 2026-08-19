"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { formatShortDate } from "@/lib/date-format";
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
  const retryRef = useRef(0);

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
        <div><p className="eyebrow">Live session</p><h1>{session.title}</h1><p>{session.objective || "No objective has been written yet."}</p></div>
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
                <div><strong>{member.displayName}{member.id === user.id && <em> You</em>}</strong><span>Joined {formatShortDate(member.joinedAt)}</span></div>
                <span className="member-role">{member.role}</span>
                <span className="presence-label" data-online={member.online}>{member.online ? "Online" : "Offline"}</span>
              </li>
            ))}
          </ul>
        </div>

        <aside className="session-actions">
          {session.role === "owner" ? (
            <section className="action-card">
              <p className="eyebrow">Invite people</p><h2>Bring your team in</h2><p>The active link is reusable until you rotate or revoke it.</p>
              {inviteUrl ? <input className="invite-value" value={inviteUrl} readOnly onFocus={(event) => event.currentTarget.select()} aria-label="Active invite link" /> : <div className="invite-empty">No active invite link.</div>}
              <div className="button-row">
                {inviteUrl && <button className="button" data-variant="primary" onClick={copyInvite}>Copy link</button>}
                <button className="button" onClick={rotateInvite} disabled={inviteBusy}>{inviteUrl ? "Rotate" : "Create link"}</button>
                {inviteUrl && <button className="button danger-button" onClick={revokeInviteLink} disabled={inviteBusy}>Revoke</button>}
              </div>
            </section>
          ) : (
            <section className="action-card"><p className="eyebrow">Membership</p><h2>You are a member</h2><p>Leaving removes this session from your home and ends your live connection.</p><button className="button danger-button" onClick={leave}>Leave session</button></section>
          )}
          <RepositoryCard sessionId={session.id} role={session.role} initialRepository={initialRepository} initialCandidate={initialCandidate} initialPreflight={initialPreflight} preflightEnabled={preflightEnabled} beginSetup={githubSetup} />
          <section className="action-card quiet-card"><p className="eyebrow">What persists</p><p>The room, objective, membership, and invite state are stored. Presence reflects live authenticated connections.</p></section>
          {notice && <p className="notice" role="status">{notice}</p>}
        </aside>
      </section>
    </main>
  );
}

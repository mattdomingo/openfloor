"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { reducePresence } from "@/lib/presence";
import type { AppUser, PresenceEvent, SessionMember, SessionSummary } from "@/lib/session-types";
import { AppHeader, initials } from "./AppHeader";

type ConnectionState = "connecting" | "connected" | "reconnecting";

export function AgentFloorScreen({
  user,
  session,
  initialMembers,
}: {
  user: AppUser;
  session: SessionSummary;
  initialMembers: SessionMember[];
}) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
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
      socket?.close(1000, "Agent floor closed");
    };
  }, [refreshMembers, session.id]);

  const visibleMembers = useMemo(
    () => members.map((member) => ({ ...member, online: onlineIds.has(member.id) })),
    [members, onlineIds],
  );
  const onlineCount = visibleMembers.filter((member) => member.online).length;

  return (
    <main className="product-shell agent-floor-shell">
      <AppHeader user={user} sessionTitle={session.title} />

      <section className="floor-heading">
        <div>
          <p className="eyebrow">Agent floor</p>
          <h1>{session.title}</h1>
          <p>{session.objective || "No objective has been written yet."}</p>
        </div>
        <div className="floor-heading-actions">
          <div className="connection-state" data-state={connection}>
            <span aria-hidden="true" />
            {connection === "connected" ? `${onlineCount} online` : connection}
          </div>
          <Link className="button" href={`/session/${session.id}`}>Session settings</Link>
        </div>
      </section>

      <section className="floor-layout">
        <aside className="floor-people floor-panel">
          <div className="floor-panel-heading">
            <div><p className="eyebrow">People</p><h2>In this room</h2></div>
            <span>{members.length}</span>
          </div>
          <ul className="floor-member-list">
            {visibleMembers.map((member) => (
              <li key={member.id}>
                <span className="avatar" aria-hidden="true">{initials(member.displayName)}</span>
                <div><strong>{member.displayName}</strong><span>{member.role}{member.id === user.id ? " · You" : ""}</span></div>
                <span className="floor-presence-dot" data-online={member.online} aria-label={member.online ? "Online" : "Offline"} />
              </li>
            ))}
          </ul>
        </aside>

        <section className="floor-agents floor-panel">
          <div className="floor-panel-heading">
            <div><p className="eyebrow">Agents</p><h2>Agent floor</h2></div>
            <span>0 active</span>
          </div>
          <div className="floor-empty">
            <div className="floor-empty-mark" aria-hidden="true">+</div>
            <h3>No agents are running</h3>
            <p>This shared floor is ready. Agent creation and execution will connect here next.</p>
          </div>
        </section>

        <aside className="floor-activity floor-panel">
          <div className="floor-panel-heading">
            <div><p className="eyebrow">Activity</p><h2>Live work</h2></div>
          </div>
          <div className="floor-activity-empty">
            <span aria-hidden="true" />
            <p>Agent events will appear here as work begins.</p>
          </div>
        </aside>
      </section>
    </main>
  );
}

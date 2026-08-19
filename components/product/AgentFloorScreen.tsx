"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { Workspace } from "@/components/session/Workspace";
import { usePersistentFloorData } from "@/components/session/usePersistentFloorData";
import { reducePresence } from "@/lib/presence";
import type { FloorSnapshot } from "@/lib/floor-types";
import { shouldRefreshFloor } from "@/lib/floor-state";
import type { AppUser, PresenceEvent, SessionMember, SessionSummary } from "@/lib/session-types";

export function AgentFloorScreen({
  user,
  session: initialSession,
  initialMembers,
  initialFloor,
}: {
  user: AppUser;
  session: SessionSummary;
  initialMembers: SessionMember[];
  initialFloor: FloorSnapshot;
}) {
  const router = useRouter();
  const [session, setSession] = useState(initialSession);
  const [members, setMembers] = useState(initialMembers);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const retryRef = useRef(0);
  const revisionRef = useRef(initialFloor.revision);
  const onMissing = useCallback(() => router.replace("/home"), [router]);
  const floorData = usePersistentFloorData(session.id, initialFloor, onMissing);
  const refreshFloor = floorData.refresh;

  useEffect(() => {
    revisionRef.current = floorData.floor.revision;
  }, [floorData.floor.revision]);

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
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}${BASE_PATH}/api/sessions/${session.id}/presence`);
      socket.addEventListener("open", () => {
        retryRef.current = 0;
        void refreshFloor();
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
        if (event.type === "members.changed") {
          void refreshMembers();
          void refreshFloor();
        }
        if (event.type === "session.changed") {
          setSession((current) => event.updatedAt >= current.updatedAt ? { ...current, objective: event.objective, updatedAt: event.updatedAt } : current);
        }
        if (shouldRefreshFloor(revisionRef.current, event)) void refreshFloor();
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        retryRef.current += 1;
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
  }, [refreshFloor, refreshMembers, session.id]);

  const visibleMembers = useMemo(
    () => members.map((member) => ({ ...member, online: onlineIds.has(member.id) })),
    [members, onlineIds],
  );

  async function saveObjective(objective: string | null): Promise<boolean> {
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { session: SessionSummary };
    setSession(body.session);
    return true;
  }

  return <Workspace user={user} session={session} members={visibleMembers} floorData={floorData} onSaveObjective={saveObjective} />;
}

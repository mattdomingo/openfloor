"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { Workspace } from "@/components/session/Workspace";
import { usePersistentFloorData } from "@/components/session/usePersistentFloorData";
import { useRunActivity } from "@/components/session/useRunActivity";
import { reducePresence } from "@/lib/presence";
import type { CredentialProvider } from "@/lib/provider-credentials";
import type { FloorSnapshot } from "@/lib/floor-types";
import { shouldRefreshFloor } from "@/lib/floor-state";
import { reduceTypingDrafts } from "@/lib/typing-drafts";
import type { AppUser, PresenceEvent, SessionMember, SessionSummary, TypingDraft, TypingUpdate } from "@/lib/session-types";

export function AgentFloorScreen({
  user,
  session: initialSession,
  initialMembers,
  initialFloor,
  agentRunEnabled,
  enabledProviders,
}: {
  user: AppUser;
  session: SessionSummary;
  initialMembers: SessionMember[];
  initialFloor: FloorSnapshot;
  agentRunEnabled: boolean;
  enabledProviders: CredentialProvider[];
}) {
  const router = useRouter();
  const [session, setSession] = useState(initialSession);
  const [members, setMembers] = useState(initialMembers);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [presenceConnected, setPresenceConnected] = useState(false);
  // Separate from floorData.error (which also carries transient mutation
  // failures) so Workspace can show a persistent banner + upgrade link only
  // for the one terminal, non-self-resolving case.
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const [typingDrafts, setTypingDrafts] = useState<Map<string, TypingDraft>>(new Map());
  const retryRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const latestTypingUpdateRef = useRef<TypingUpdate>({ type: "typing.update", text: "", typing: false });
  const revisionRef = useRef(initialFloor.revision);
  const onMissing = useCallback(() => router.replace("/home"), [router]);
  const floorData = usePersistentFloorData(session.id, initialFloor, onMissing);
  const refreshFloor = floorData.refresh;
  const setFloorError = floorData.setError;
  const activity = useRunActivity(session.id);
  // Only these two stable callbacks feed the socket effect; depending on the
  // whole `activity` object would reconnect the socket on every event batch.
  const { ingest: ingestActivity, catchUp: catchUpActivity } = activity;
  const activeRunIdsRef = useRef<string[]>([]);

  useEffect(() => {
    revisionRef.current = floorData.floor.revision;
    activeRunIdsRef.current = floorData.floor.runs
      .filter((run) => ["provisioning", "running", "checking", "cancel_requested"].includes(run.status))
      .map((run) => run.id);
  }, [floorData.floor.revision, floorData.floor.runs]);

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
    let heartbeatTimer: number | null = null;
    let disposed = false;
    // Real presence, not merely an open socket: the DO's idle timeout (30
    // min) trims billing to this, so an unattended-but-visible tab must not
    // look active. Deliberately window-level and un-throttled — cost is a
    // timestamp write per event, no re-render.
    let lastInputAt = Date.now();
    // Set on a 4003 close and never cleared: quota is terminal for the rest
    // of this billing period, so reconnect attempts must stay blocked even
    // though socketRef/retryTimer look identical to the idle-close case.
    let quotaExhaustedLocal = false;

    function tryReconnectAfterIdleClose() {
      if (!disposed && !quotaExhaustedLocal && document.visibilityState === "visible" && socketRef.current === null && retryTimer === null) {
        connect();
      }
    }

    function noteInput() {
      lastInputAt = Date.now();
      tryReconnectAfterIdleClose();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") noteInput();
    }

    function connect() {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}${BASE_PATH}/api/sessions/${session.id}/presence`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        retryRef.current = 0;
        setPresenceConnected(true);
        setQuotaExhausted(false);
        if (latestTypingUpdateRef.current.text) socket?.send(JSON.stringify(latestTypingUpdateRef.current));
        void refreshFloor();
        catchUpActivity(activeRunIdsRef.current);
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
        if (event.type === "presence.snapshot" || event.type === "typing.changed") {
          setTypingDrafts((current) => reduceTypingDrafts(current, event));
        }
        if (event.type === "members.changed") {
          void refreshMembers();
          void refreshFloor();
        }
        if (event.type === "session.changed") {
          setSession((current) => event.updatedAt >= current.updatedAt ? { ...current, objective: event.objective, updatedAt: event.updatedAt } : current);
        }
        if (event.type === "session.ended") {
          setSession((current) => ({ ...current, endedAt: event.endedAt, endedReason: event.reason }));
        }
        if (event.type === "session.locked") {
          setSession((current) => ({ ...current, lockedAt: event.lockedAt }));
        }
        if (event.type === "run.activity") ingestActivity(event);
        if (event.type === "floor.changed" && event.domains.includes("runs")) catchUpActivity(activeRunIdsRef.current);
        if (shouldRefreshFloor(revisionRef.current, event)) void refreshFloor();
      });
      socket.addEventListener("close", (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        setPresenceConnected(false);
        if (disposed) return;
        if (event.code === 4003) {
          // Hour quota exhausted: surface the reason and stop reconnecting.
          quotaExhaustedLocal = true;
          setFloorError(event.reason || "This session's host has used up their plan's monthly session hours.");
          setQuotaExhausted(true);
          return;
        }
        if (event.code === 4001) {
          // Membership ended: this connection is no longer valid. Leave
          // instead of retrying — previously this fell into the backoff
          // branch below, reconnected, got a bare 404 on the upgrade (opaque
          // as code 1006 to the browser), and looped forever at one attempt
          // per 10s.
          router.replace("/home");
          return;
        }
        if (event.code === 4005) {
          // Owner-initiated removal: distinct from 4001 so /home can say
          // what actually happened. sessionStorage is the only way to carry
          // the reason across this client-side navigation.
          sessionStorage.setItem("openfloor:removed-notice", event.reason || "The owner removed you from this session.");
          router.replace("/home");
          return;
        }
        if (event.code === 4004) {
          // Idle timeout: paused, not terminal. Reconnect the instant the
          // user is back (handled by noteInput/handleVisibilityChange)
          // rather than backing off — there is nothing to back off from.
          setFloorError(event.reason || "Disconnected after a period of inactivity.");
          retryRef.current = 0;
          return;
        }
        retryRef.current += 1;
        const delay = Math.min(10_000, 500 * 2 ** Math.min(retryRef.current - 1, 5));
        retryTimer = window.setTimeout(connect, delay);
      });
    }

    const inputEvents = ["pointermove", "keydown", "focus", "scroll"] as const;
    for (const eventName of inputEvents) window.addEventListener(eventName, noteInput, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Heartbeat: only while the tab is visible and there has been real user
    // input recently, so an unattended tab (backgrounded or merely left
    // open) stops refreshing lastActivityAt server-side and the DO's idle
    // timeout can actually trim its billing.
    heartbeatTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInputAt > 5 * 60_000) return;
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send("ping");
    }, 30_000);

    connect();
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      for (const eventName of inputEvents) window.removeEventListener(eventName, noteInput);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "typing.update", text: "", typing: false } satisfies TypingUpdate));
      }
      socket?.close(1000, "Agent floor closed");
    };
  }, [catchUpActivity, ingestActivity, refreshFloor, refreshMembers, router, session.id, setFloorError]);

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

  const sendTypingUpdate = useCallback((text: string, typing: boolean) => {
    const update: TypingUpdate = { type: "typing.update", text, typing: Boolean(text) && typing };
    latestTypingUpdateRef.current = update;
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(update));
  }, []);

  return <Workspace user={user} session={session} members={visibleMembers} floorData={floorData} activity={activity} typingDrafts={typingDrafts} onTypingUpdate={sendTypingUpdate} onSaveObjective={saveObjective} agentRunEnabled={agentRunEnabled} enabledProviders={enabledProviders} presenceConnected={presenceConnected} quotaExhausted={quotaExhausted} />;
}

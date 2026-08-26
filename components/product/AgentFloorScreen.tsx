"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { Workspace } from "@/components/session/Workspace";
import { usePersistentFloorData } from "@/components/session/usePersistentFloorData";
import { usePresenceSocket } from "@/components/session/usePresenceSocket";
import { useRepositoryTree } from "@/components/session/useRepositoryTree";
import { useRunActivity } from "@/components/session/useRunActivity";
import { reducePresence } from "@/lib/presence";
import type { CredentialProvider, ProviderCredentialSummary } from "@/lib/provider-credentials";
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
  providerCredentials,
  lowHoursRemaining,
}: {
  user: AppUser;
  session: SessionSummary;
  initialMembers: SessionMember[];
  initialFloor: FloorSnapshot;
  agentRunEnabled: boolean;
  enabledProviders: CredentialProvider[];
  providerCredentials: ProviderCredentialSummary[];
  lowHoursRemaining: number | null;
}) {
  const router = useRouter();
  const [session, setSession] = useState(initialSession);
  const [members, setMembers] = useState(initialMembers);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [typingDrafts, setTypingDrafts] = useState<Map<string, TypingDraft>>(new Map());
  const latestTypingUpdateRef = useRef<TypingUpdate>({ type: "typing.update", text: "", typing: false });
  const revisionRef = useRef(initialFloor.revision);
  const onMissing = useCallback(() => router.replace("/home"), [router]);
  const floorData = usePersistentFloorData(session.id, initialFloor, onMissing);
  const refreshFloor = floorData.refresh;
  const setFloorError = floorData.setError;
  const activity = useRunActivity(session.id);
  const repositoryTree = useRepositoryTree(session.id);
  const resetRepositoryTree = repositoryTree.reset;
  // Only these two stable callbacks feed the socket handlers below; depending
  // on the whole `activity` object would rebuild them on every event batch.
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

  const handlePresenceEvent = useCallback((event: PresenceEvent) => {
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
    // A new candidate head (or a disconnect) invalidates the browsed tree/blobs; the Review
    // screen re-requests them lazily the next time it needs one.
    if (event.type === "floor.changed" && event.domains.includes("repository")) resetRepositoryTree();
    if (shouldRefreshFloor(revisionRef.current, event)) void refreshFloor();
  }, [catchUpActivity, ingestActivity, refreshFloor, refreshMembers, resetRepositoryTree]);

  const handleLive = useCallback((send: (update: TypingUpdate) => void) => {
    if (latestTypingUpdateRef.current.text) send(latestTypingUpdateRef.current);
    void refreshFloor();
    catchUpActivity(activeRunIdsRef.current);
  }, [refreshFloor, catchUpActivity]);

  const handleLeave = useCallback((code: 4001 | 4005, reason: string) => {
    if (code === 4005) {
      // Owner-initiated removal: distinct from 4001 so /home can say what
      // actually happened. sessionStorage is the only way to carry the
      // reason across this client-side navigation.
      sessionStorage.setItem("openfloor:removed-notice", reason || "The owner removed you from this session.");
    }
    router.replace("/home");
  }, [router]);

  const { connection, send } = usePresenceSocket(session.id, {
    onEvent: handlePresenceEvent,
    onLive: handleLive,
    onLeave: handleLeave,
  });

  // Clear this member's typing draft for everyone else before the socket
  // closes on unmount — usePresenceSocket's own cleanup (which runs after
  // this one, since it was registered first) does the actual close.
  useEffect(() => () => { send({ type: "typing.update", text: "", typing: false }); }, [send]);

  useEffect(() => {
    if (connection.status === "quota-exhausted") {
      setFloorError(connection.reason || "This session's host has used up their plan's monthly session hours.");
    } else if (connection.status === "idle") {
      setFloorError(connection.reason || "Disconnected after a period of inactivity.");
    }
  }, [connection.status, connection.reason, setFloorError]);

  const presenceConnected = connection.status === "live";
  const quotaExhausted = connection.status === "quota-exhausted";

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
    send(update);
  }, [send]);

  return <Workspace user={user} session={session} members={visibleMembers} floorData={floorData} activity={activity} repositoryTree={repositoryTree} typingDrafts={typingDrafts} onTypingUpdate={sendTypingUpdate} onSaveObjective={saveObjective} agentRunEnabled={agentRunEnabled} enabledProviders={enabledProviders} providerCredentials={providerCredentials} presenceConnected={presenceConnected} quotaExhausted={quotaExhausted} lowHoursRemaining={lowHoursRemaining} />;
}

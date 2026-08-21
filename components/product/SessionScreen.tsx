"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { useDialogDismiss } from "@/components/session/primitives";
import { initials } from "@/lib/display-name";
import { reducePresence } from "@/lib/presence";
import { isRepositoryReadyForFloor } from "@/lib/repository-gate";
import type { AppUser, PresenceEvent, RemovedSessionMember, RepositoryCandidate, RepositoryConnection, RepositoryPreflight, SessionMember, SessionSummary } from "@/lib/session-types";
import { AppHeader } from "./AppHeader";
import { RepositoryCard } from "./RepositoryCard";
import { SkillsCard } from "./SkillsCard";
import type { SessionSkillSummary } from "@/db/skills";

type ConnectionState = "connecting" | "connected" | "reconnecting";

export function SessionScreen({
  user,
  session,
  initialMembers,
  initialRemovedMembers,
  initialRepository,
  initialCandidate,
  initialPreflight,
  preflightEnabled,
  claudeRunEnabled,
  initialSkills,
  githubSetup,
  repoGateRequested,
}: {
  user: AppUser;
  session: SessionSummary;
  initialMembers: SessionMember[];
  initialRemovedMembers: RemovedSessionMember[];
  initialRepository: RepositoryConnection | null;
  initialCandidate: RepositoryCandidate | null;
  initialPreflight: RepositoryPreflight | null;
  preflightEnabled: boolean;
  claudeRunEnabled: boolean;
  initialSkills: SessionSkillSummary[];
  githubSetup: boolean;
  repoGateRequested: boolean;
}) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [removedMembers, setRemovedMembers] = useState(initialRemovedMembers);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [inviteUrl, setInviteUrl] = useState<string | null | undefined>(undefined);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SessionMember | null>(null);
  const [restoreBusy, setRestoreBusy] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const repositoryReady = isRepositoryReadyForFloor(initialRepository, initialCandidate);
  const [repoGateOpen, setRepoGateOpen] = useState(repoGateRequested && !repositoryReady);
  const [repositoryHighlighted, setRepositoryHighlighted] = useState(false);
  const repositoryCardRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef(0);
  const endedAt = session.endedAt;

  function enterAgentFloor(event: MouseEvent<HTMLAnchorElement>) {
    if (repositoryReady) return;
    event.preventDefault();
    setRepoGateOpen(true);
  }

  function goToRepositorySetup() {
    setRepoGateOpen(false);
    repositoryCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setRepositoryHighlighted(true);
    window.setTimeout(() => setRepositoryHighlighted(false), 2200);
  }

  const refreshMembers = useCallback(async () => {
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/members`, { cache: "no-store" });
    if (response.status === 404) {
      router.replace("/home");
      return;
    }
    if (!response.ok) return;
    const body = (await response.json()) as { members: SessionMember[]; removedMembers: RemovedSessionMember[] };
    setMembers(body.members);
    setRemovedMembers(body.removedMembers);
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
        // Re-fetches session.lockedAt from the server rather than patching
        // local state, matching how session.ended is already handled here.
        if (event.type === "session.locked") router.refresh();
        if (event.type === "floor.changed" && event.domains.some((domain) => domain === "repository" || domain === "review")) router.refresh();
      });
      socket.addEventListener("close", (event) => {
        if (disposed) return;
        if (event.code === 4005) {
          // Owner-initiated removal: leave instead of retrying, and carry the
          // reason to /home the same way AgentFloorScreen already does for
          // its own presence socket.
          sessionStorage.setItem("openfloor:removed-notice", event.reason || "The owner removed you from this session.");
          router.replace("/home");
          return;
        }
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

  async function restoreMemberAccess(memberId: string) {
    setRestoreBusy(memberId);
    setRestoreError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/members/${memberId}`, { method: "POST" });
    if (response.ok) {
      await refreshMembers();
      setNotice("Member allowed back in.");
    } else {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setRestoreError(body?.error ?? "Unable to restore this member.");
    }
    setRestoreBusy(null);
  }

  async function toggleLock() {
    setLockBusy(true);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/lock`, { method: session.lockedAt == null ? "POST" : "DELETE" });
    if (response.ok) router.refresh();
    setLockBusy(false);
  }

  return (
    <main className="product-shell">
      <AppHeader user={user} sessionTitle={session.title} />
      <section className="session-hero">
        <div><p className="eyebrow">{endedAt != null ? "Ended session" : "Live session"}</p><h1>{session.title}</h1><p>{session.objective || "No objective has been written yet."}</p></div>
        <div className="session-hero-actions">
          <div className="connection-state" data-state={connection}><span aria-hidden="true" />{connection === "connected" ? `${onlineCount} online` : connection}</div>
          <Link className="button" data-variant="primary" data-size="lg" href={`/session/${session.id}/floor`} onClick={enterAgentFloor} aria-haspopup={repositoryReady ? undefined : "dialog"}>Enter agent floor</Link>
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
                {session.role === "owner" && member.id !== user.id && (
                  <button type="button" className="button danger-button" data-size="sm" onClick={() => setRemoveTarget(member)}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </div>

        {session.role === "owner" && removedMembers.length > 0 && (
          <div className="member-panel removed-panel">
            <div className="panel-heading"><div><p className="eyebrow">Removed</p><h2>No longer in this session</h2></div><span>{removedMembers.length}</span></div>
            <ul className="member-list">
              {removedMembers.map((member) => (
                <li key={member.id}>
                  <span className="avatar" aria-hidden="true">{initials(member.displayName)}</span>
                  <div><strong title={member.displayName}>{member.displayName}</strong><span>Removed <LocalDateTime timestamp={member.removedAt} mode="date" /></span></div>
                  <button type="button" className="button" data-size="sm" disabled={restoreBusy === member.id} onClick={() => restoreMemberAccess(member.id)}>
                    {restoreBusy === member.id ? "Restoring…" : "Allow back in"}
                  </button>
                </li>
              ))}
            </ul>
            {restoreError && <p className="form-error" role="alert">{restoreError}</p>}
          </div>
        )}

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
                  <p className="eyebrow">Access</p><h2>{session.lockedAt == null ? "Lock this session" : "This session is locked"}</h2>
                  <p>{session.lockedAt == null
                    ? "Locks the door. Nobody new can join with the invite link. Everyone already here is unaffected."
                    : "The invite link is suspended — nobody new can join. Unlock to let people in again."}</p>
                  <button className="button" data-variant={session.lockedAt == null ? undefined : "primary"} onClick={toggleLock} disabled={lockBusy}>
                    {session.lockedAt == null ? "Lock session" : "Unlock session"}
                  </button>
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
          {endedAt == null && (
            <div ref={repositoryCardRef} className="repository-card-slot" data-highlighted={repositoryHighlighted}>
              <RepositoryCard sessionId={session.id} sessionTitle={session.title} sessionObjective={session.objective} role={session.role} initialRepository={initialRepository} initialCandidate={initialCandidate} initialPreflight={initialPreflight} preflightEnabled={preflightEnabled} beginSetup={githubSetup} />
              {claudeRunEnabled && <SkillsCard sessionId={session.id} role={session.role} initialSkills={initialSkills} />}
            </div>
          )}
          <section className="action-card quiet-card"><p className="eyebrow">Saved automatically</p><p>The session, its objective, members, and invite state are stored. Presence shows who is connected right now.</p></section>
          {notice && <p className="notice" role="status">{notice}</p>}
        </aside>
      </section>
      {ending && <EndSessionDialog sessionId={session.id} onClose={() => setEnding(false)} />}
      {removeTarget && (
        <RemoveMemberDialog
          sessionId={session.id}
          member={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            setNotice(`${removeTarget.displayName} was removed.`);
            void refreshMembers();
          }}
        />
      )}
      {repoGateOpen && (
        <RepositoryGateDialog
          role={session.role}
          repository={initialRepository}
          candidate={initialCandidate}
          onClose={() => setRepoGateOpen(false)}
          onGoToSetup={goToRepositorySetup}
        />
      )}
    </main>
  );
}

function RepositoryGateDialog({ role, repository, candidate, onClose, onGoToSetup }: {
  role: SessionSummary["role"];
  repository: RepositoryConnection | null;
  candidate: RepositoryCandidate | null;
  onClose: () => void;
  onGoToSetup: () => void;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const connected = repository != null && repository.status !== "disconnected" && repository.status !== "revoked" && repository.status !== "inaccessible";
  const needsReconnect = repository != null && (repository.status === "revoked" || repository.status === "inaccessible" || repository.status === "disconnected");
  const executionEnabled = candidate != null;

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="repo-gate-title">
      <div className="dialog-head">
        <div className="dialog-title">
          <h2 id="repo-gate-title">Connect a repository to enter the agent floor</h2>
          <p>Agents need a GitHub repository connected and ready before they can work in this session.</p>
        </div>
      </div>
      <div className="dialog-body">
        <ol className="repo-gate-checklist">
          <li data-done={connected}>
            <span aria-hidden="true">{connected ? "✓" : "○"}</span>
            <span>{needsReconnect ? `GitHub connection needs attention (${repository ? repository.status.replaceAll("_", " ") : ""})` : "Connect a GitHub repository"}</span>
          </li>
          <li data-done={executionEnabled}>
            <span aria-hidden="true">{executionEnabled ? "✓" : "○"}</span>
            <span>Enable execution (creates the candidate branch agents work from)</span>
          </li>
        </ol>
        <p className="form-note">
          Check commands are optional. If you configure them, agent changes must pass those commands before a run is marked ready; without them, changes still run but aren&apos;t verified automatically.
        </p>
        {role !== "owner" && <p className="form-note">Only the session owner can connect GitHub. Ask them to finish setup from this page.</p>}
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss}>Not now</button>
        {role === "owner" && <button type="button" className="button" data-variant="primary" onClick={onGoToSetup}>Go to repository setup</button>}
      </div>
    </dialog>
  );
}

function RemoveMemberDialog({ sessionId, member, onClose, onRemoved }: {
  sessionId: string;
  member: SessionMember;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/members/${member.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Unable to remove this member.");
      setBusy(false);
      return;
    }
    onRemoved();
    dismiss();
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="remove-member-title">
      <div className="dialog-head">
        <div className="dialog-title">
          <h2 id="remove-member-title">Remove {member.displayName}?</h2>
          <p>Their chat messages and prompts stay as session history. Any agents they own move to you. They won&apos;t be able to rejoin with the current invite link, but you can allow them back in later.</p>
        </div>
      </div>
      {error && <div className="dialog-body"><p className="form-error" role="alert">{error}</p></div>}
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        <button type="button" className="button danger-button" onClick={confirm} disabled={busy}>Remove</button>
      </div>
    </dialog>
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

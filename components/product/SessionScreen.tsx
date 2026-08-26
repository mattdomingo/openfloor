"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { useDialogDismiss } from "@/components/session/primitives";
import { QuotaNotice } from "@/components/session/QuotaNotice";
import { usePresenceSocket } from "@/components/session/usePresenceSocket";
import { initials } from "@/lib/display-name";
import { reducePresence } from "@/lib/presence";
import { isRepositoryReadyForFloor } from "@/lib/repository-gate";
import { usesClaudeRunner, type CredentialProvider } from "@/lib/provider-credentials";
import type { AppUser, PresenceEvent, RemovedSessionMember, RepositoryCandidate, RepositoryConnection, RepositoryPreflight, SessionMember, SessionSummary } from "@/lib/session-types";
import { AppHeader } from "./AppHeader";
import { RepositoryCard } from "./RepositoryCard";
import { SkillsCard } from "./SkillsCard";
import { McpServersCard } from "./McpServersCard";
import type { SessionMcpServerSummary } from "@/db/mcp-servers";
import type { SessionSkillSummary } from "@/db/skills";
import { WaveField } from "@/app/entry-wave";

export function SessionScreen({
  user,
  session,
  initialMembers,
  initialRemovedMembers,
  initialRepository,
  initialCandidate,
  initialPreflight,
  preflightEnabled,
  enabledProviders,
  initialSkills,
  initialMcpServers,
  repoGateRequested,
  lowHoursRemaining,
}: {
  user: AppUser;
  session: SessionSummary;
  initialMembers: SessionMember[];
  initialRemovedMembers: RemovedSessionMember[];
  initialRepository: RepositoryConnection | null;
  initialCandidate: RepositoryCandidate | null;
  initialPreflight: RepositoryPreflight | null;
  preflightEnabled: boolean;
  enabledProviders: CredentialProvider[];
  initialSkills: SessionSkillSummary[];
  initialMcpServers: SessionMcpServerSummary[];
  repoGateRequested: boolean;
  /* Seconds of plan time left, read once on the server and only when the
     owner is already inside the warning band. It ages while the page stays
     open, which is fine in one direction: the number only ever overstates
     what is left, and hitting zero closes the socket and swaps in the
     exhausted banner. */
  lowHoursRemaining: number | null;
}) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [removedMembers, setRemovedMembers] = useState(initialRemovedMembers);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const [inviteUrl, setInviteUrl] = useState<string | null | undefined>(undefined);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SessionMember | null>(null);
  const [restoreBusy, setRestoreBusy] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const endedAt = session.endedAt;
  const [repository, setRepository] = useState(initialRepository);
  const [candidate, setCandidate] = useState(initialCandidate);
  const [syncedRepository, setSyncedRepository] = useState(initialRepository);
  const [syncedCandidate, setSyncedCandidate] = useState(initialCandidate);
  if (syncedRepository !== initialRepository || syncedCandidate !== initialCandidate) {
    setSyncedRepository(initialRepository);
    setSyncedCandidate(initialCandidate);
    setRepository(initialRepository);
    setCandidate(initialCandidate);
  }
  const repositoryReady = isRepositoryReadyForFloor(repository, candidate);
  const floorAccessible = endedAt != null || repositoryReady;
  const [repoGateOpen, setRepoGateOpen] = useState(repoGateRequested && !repositoryReady);
  const [repositoryHighlighted, setRepositoryHighlighted] = useState(false);
  const repositoryCardRef = useRef<HTMLDivElement>(null);

  function enterAgentFloor(event: MouseEvent<HTMLAnchorElement>) {
    if (floorAccessible) return;
    event.preventDefault();
    setRepoGateOpen(true);
  }

  function updateRepositoryState(state: { repository: RepositoryConnection | null; candidate: RepositoryCandidate | null }) {
    setRepository(state.repository);
    setCandidate(state.candidate);
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

  const handlePresenceEvent = useCallback((event: PresenceEvent) => {
    if (event.type === "presence.snapshot" || event.type === "presence.changed") {
      setOnlineIds((current) => reducePresence(current, event));
    }
    if (event.type === "members.changed") void refreshMembers();
    if (event.type === "session.ended") router.refresh();
    // Re-fetches session.lockedAt from the server rather than patching local
    // state, matching how session.ended is already handled here.
    if (event.type === "session.locked") router.refresh();
    if (event.type === "floor.changed" && event.domains.some((domain) => domain === "repository" || domain === "review")) router.refresh();
  }, [refreshMembers, router]);

  const handleLive = useCallback(() => {}, []);

  const handleLeave = useCallback((code: 4001 | 4005, reason: string) => {
    if (code === 4005) {
      // Owner-initiated removal: distinct from a plain 4001 (e.g. voluntary
      // leave) so /home can say what actually happened.
      sessionStorage.setItem("openfloor:removed-notice", reason || "The owner removed you from this session.");
    }
    router.replace("/home");
  }, [router]);

  const { connection } = usePresenceSocket(session.id, {
    onEvent: handlePresenceEvent,
    onLive: handleLive,
    onLeave: handleLeave,
  });

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
    <main className="product-shell shop-shell session-lobby-shell">
      <WaveField varName="--wave" className="shop-wave" />
      <AppHeader user={user} sessionTitle={session.title} />
      <section className="session-hero lobby-hero">
        <div>
          <p className="eyebrow">{endedAt != null ? "Ended session" : "Live session"}</p>
          <h1>{session.title}</h1>
          <p>{session.objective || "No objective has been written yet."}</p>
          <div className="lobby-hero-meta">
            <span>{members.length} {members.length === 1 ? "member" : "members"}</span>
            <span>{repositoryReady ? "Floor ready" : "Setup incomplete"}</span>
          </div>
        </div>
        <div className="session-hero-actions">
          <div className="connection-state" data-state={connection.status === "live" ? "connected" : connection.status}><span aria-hidden="true" />{connection.status === "live" ? `${onlineCount} online` : connection.status}</div>
          {session.role === "owner" && endedAt == null && !repositoryReady && (
            <button type="button" className="button" onClick={goToRepositorySetup}>Repository setup</button>
          )}
          <Link className="button" data-variant="primary" data-size="lg" href={`/session/${session.id}/floor`} onClick={enterAgentFloor} aria-haspopup={floorAccessible ? undefined : "dialog"}>Enter agent floor</Link>
        </div>
      </section>

      <div className="lobby-body">
        {connection.status === "quota-exhausted" && endedAt == null && <QuotaNotice sessionId={session.id} role={session.role} />}
        {connection.status !== "quota-exhausted" && endedAt == null && lowHoursRemaining != null && (
          <QuotaNotice sessionId={session.id} role={session.role} remainingSeconds={lowHoursRemaining} />
        )}
        {endedAt != null && (
          <section className="lobby-ended" aria-label="Session ended">
            <p className="eyebrow">Read only</p>
            <p>
              {session.endedReason === "merged"
                ? <>This session ended <LocalDateTime timestamp={endedAt} mode="date" /> because the candidate branch was merged.</>
                : <>This session ended <LocalDateTime timestamp={endedAt} mode="date" />.</>} The floor remains readable and the invite link is revoked.
            </p>
          </section>
        )}

        <section className="lobby-team-access" aria-label="Team and access">
          <div className="member-panel lobby-surface">
            <div className="panel-heading"><div><p className="eyebrow">Team</p><h2>Session members</h2></div><span>{members.length}</span></div>
            <ul className="member-list">
              {visibleMembers.map((member) => (
                <li key={member.id}>
                  <span className="avatar" aria-hidden="true">{initials(member.displayName)}</span>
                  <div><strong title={member.displayName}>{member.displayName}{member.id === user.id && <em> You</em>}</strong><span>Joined <LocalDateTime timestamp={member.joinedAt} mode="date" /></span></div>
                  <span className="member-role">{member.role}</span>
                  <span className="presence-label" data-online={member.online}>{member.online ? "Online" : "Offline"}</span>
                  {session.role === "owner" && member.id !== user.id && endedAt == null && (
                    <button type="button" className="button danger-button" data-size="sm" onClick={() => setRemoveTarget(member)}>Remove</button>
                  )}
                </li>
              ))}
            </ul>
            {session.role === "owner" && removedMembers.length > 0 && (
              <div className="removed-members">
                <div className="panel-heading"><div><p className="eyebrow">Removed</p><h2>No longer in this session</h2></div><span>{removedMembers.length}</span></div>
                <ul className="member-list">
                  {removedMembers.map((member) => (
                    <li key={member.id}>
                      <span className="avatar" aria-hidden="true">{initials(member.displayName)}</span>
                      <div><strong title={member.displayName}>{member.displayName}</strong><span>Removed <LocalDateTime timestamp={member.removedAt} mode="date" /></span></div>
                      {endedAt == null && <button type="button" className="button" data-size="sm" disabled={restoreBusy === member.id} onClick={() => restoreMemberAccess(member.id)}>{restoreBusy === member.id ? "Restoring…" : "Allow back in"}</button>}
                    </li>
                  ))}
                </ul>
                {restoreError && <p className="form-error" role="alert">{restoreError}</p>}
              </div>
            )}
          </div>

          <section className="action-card lobby-surface access-card">
            <p className="eyebrow">Access</p>
            {session.role === "owner" && endedAt == null ? (
              <>
                <h2>Invite and lock</h2>
                <p>The active invite is reusable. Locking suspends new joins without affecting anyone already here.</p>
                {inviteUrl ? <input className="invite-value" value={inviteUrl} readOnly onFocus={(event) => event.currentTarget.select()} aria-label="Active invite link" /> : <div className="invite-empty">No active invite link.</div>}
                <div className="button-row">
                  {inviteUrl && <button className="button" data-variant="primary" onClick={copyInvite}>Copy link</button>}
                  <button className="button" onClick={rotateInvite} disabled={inviteBusy}>{inviteUrl ? "Rotate" : "Create link"}</button>
                  {inviteUrl && <button className="button danger-button" onClick={revokeInviteLink} disabled={inviteBusy}>Revoke</button>}
                </div>
                <div className="access-lock-row">
                  <div><strong>{session.lockedAt == null ? "Open to invited people" : "Session locked"}</strong><span>{session.lockedAt == null ? "Current invite holders may join." : "New joins are suspended."}</span></div>
                  <button className="button" data-variant={session.lockedAt == null ? undefined : "primary"} onClick={toggleLock} disabled={lockBusy}>{session.lockedAt == null ? "Lock session" : "Unlock session"}</button>
                </div>
              </>
            ) : (
              <>
                <h2>{endedAt == null ? "Member access" : "Session closed"}</h2>
                <p>{endedAt == null ? "You are a member of this session. Only the owner can manage invites and locking." : "The invite is revoked and this session is read-only."}</p>
              </>
            )}
          </section>
        </section>

        {endedAt == null && (
          <section className="floor-setup-section" aria-labelledby="floor-setup-title">
            <div className="floor-setup-heading">
              <div><p className="eyebrow">Floor setup</p><h2 id="floor-setup-title">Prepare the workspace</h2><p>Repository access is required for the live floor. Skills and MCP servers are optional.</p></div>
              <span className="setup-status" data-ready={repositoryReady}>{repositoryReady ? "Ready" : "Repository required"}</span>
            </div>
            <div ref={repositoryCardRef} className="repository-card-slot" data-highlighted={repositoryHighlighted}>
              <RepositoryCard sessionId={session.id} sessionTitle={session.title} sessionObjective={session.objective} role={session.role} initialRepository={repository} initialCandidate={candidate} initialPreflight={initialPreflight} preflightEnabled={preflightEnabled} beginSetup={false} onStateChange={updateRepositoryState} />
            </div>
            {enabledProviders.some(usesClaudeRunner) && (
              <div className="floor-setup-secondary">
                <SkillsCard sessionId={session.id} role={session.role} initialSkills={initialSkills} />
                <McpServersCard sessionId={session.id} role={session.role} initialServers={initialMcpServers} />
              </div>
            )}
          </section>
        )}

        {(session.role !== "owner" || endedAt == null) && (
          <section className="lobby-bottom-controls">
            <div><p className="eyebrow">Session controls</p><p>{session.role === "owner" ? "Ending makes the floor read-only and revokes the invite. Nothing is deleted." : "Leaving removes this session from your home and ends your live connection."}</p></div>
            {session.role === "owner" ? <button className="button danger-button" onClick={() => setEnding(true)}>End session</button> : <button className="button danger-button" onClick={leave}>Leave session</button>}
          </section>
        )}
        {notice && <p className="notice" role="status">{notice}</p>}
      </div>
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
          repository={repository}
          candidate={candidate}
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
  const candidateReady = candidate != null;

  return (
    <dialog className="dialog repository-gate-dialog" {...dialogProps} aria-labelledby="repo-gate-title">
      <div className="dialog-head">
        <div className="dialog-title">
          <h2 id="repo-gate-title">Repository setup required</h2>
          <p>Select a repository authorized in Account Settings and prepare its candidate branch before entering the agent floor.</p>
        </div>
      </div>
      <div className="dialog-body">
        <ol className="repo-gate-checklist">
          <li data-done={connected}>
            <span aria-hidden="true">{connected ? "✓" : "○"}</span>
            <span>{needsReconnect ? `Repository access needs attention (${repository ? repository.status.replaceAll("_", " ") : ""})` : "Repository access ready"}</span>
          </li>
          <li data-done={candidateReady}>
            <span aria-hidden="true">{candidateReady ? "✓" : "○"}</span>
            <span>Candidate branch ready</span>
          </li>
        </ol>
        <p className="form-note">
          Check commands are optional. If you configure them, agent changes must pass those commands before a run is marked ready; without them, changes still run but aren&apos;t verified automatically.
        </p>
        {role !== "owner" && <p className="form-note">Only the session owner can finish repository setup. Ask them to complete it from this page.</p>}
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

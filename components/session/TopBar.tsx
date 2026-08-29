"use client";

import Link from "next/link";
import { memo, useEffect, useRef, useState } from "react";
import { AccountMenu } from "@/components/product/AccountMenu";
import { Brand } from "@/components/product/Brand";
import { LocalDateTime } from "@/components/LocalDateTime";
import { formatDuration } from "@/lib/date-format";
import { initials } from "@/lib/display-name";
import { OBJECTIVE_NUDGE_THRESHOLD } from "@/lib/floor-state";
import type { AppUser, RepositoryConnection, SessionMember, SessionSummary } from "@/lib/session-types";
import { InviteDialog } from "./InviteDialog";
import { Avatar, Icon } from "./primitives";
import type { WorkspaceScreen } from "./data";

type ObjectiveSaveState = "idle" | "saving" | "saved" | "error";

function abbreviatedBranch(branch: string): string {
  if (branch.length <= 24) return branch;
  const leaf = branch.split("/").at(-1) || branch;
  const scopedLeaf = leaf === branch ? leaf : `…/${leaf}`;
  if (scopedLeaf.length <= 28) return scopedLeaf;
  return `${scopedLeaf.slice(0, 18)}…${scopedLeaf.slice(-8)}`;
}

/* Active-session-time readout. The server value lags real usage by up to one
   flush interval (ponytail: accepted); while this viewer is connected the
   session is by definition occupied, so the client ticks the display forward
   itself. Ticks re-render only this span, and it is plain text — no aria-live,
   so screen readers are not spammed once a second. */
function SessionTimer({ base, running }: { base: number; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return (
    <span className="objective-fact session-timer" title="Session time used">
      {formatDuration(base + elapsed)}
    </span>
  );
}

export const TopBar = memo(function TopBar({
  screen,
  onScreen,
  onNotice,
  session,
  user,
  members,
  unreadTeamCount,
  reviewAttentionCount,
  presenceConnected,
  staleMessageCount,
  onSaveObjective,
  repository,
  branch,
}: {
  screen: WorkspaceScreen;
  onScreen: (screen: WorkspaceScreen) => void;
  onNotice: (notice: string) => void;
  session: SessionSummary;
  user: AppUser;
  members: SessionMember[];
  unreadTeamCount: number;
  reviewAttentionCount: number;
  presenceConnected: boolean;
  staleMessageCount: number;
  onSaveObjective: (objective: string | null) => Promise<boolean>;
  repository: RepositoryConnection | null;
  branch: string | null;
}) {
  const [inviting, setInviting] = useState(false);
  const inviteButtonRef = useRef<HTMLButtonElement>(null);

  const [editingObjective, setEditingObjective] = useState(false);
  const [objectiveDraft, setObjectiveDraft] = useState(session.objective ?? "");
  const [objectiveSaveState, setObjectiveSaveState] = useState<ObjectiveSaveState>("idle");
  const [objectiveEditVersion, setObjectiveEditVersion] = useState(session.updatedAt);
  const objectiveChangedElsewhere = editingObjective && session.updatedAt > objectiveEditVersion;
  // Escape removes the textarea from the DOM while it still has focus, which
  // fires a native blur on it — this flag tells that blur to skip the save
  // it would otherwise trigger, so Escape actually cancels instead of
  // committing whatever was last typed.
  const skipBlurSaveRef = useRef(false);

  function closeInvite() {
    setInviting(false);
    inviteButtonRef.current?.focus();
  }

  function beginEditingObjective() {
    setObjectiveEditVersion(session.updatedAt);
    setObjectiveDraft(session.objective ?? "");
    setObjectiveSaveState("idle");
    setEditingObjective(true);
  }

  async function saveObjective() {
    if (!editingObjective || objectiveSaveState === "saving") return;
    setObjectiveSaveState("saving");
    const ok = await onSaveObjective(objectiveDraft.trim() || null);
    if (!ok) {
      setObjectiveSaveState("error");
      return;
    }
    setObjectiveSaveState("saved");
    setEditingObjective(false);
  }

  return (
    <header className="topbar">
      {/* Identity: brand + where-you-are navigation. */}
      <Brand />

      <span className="topbar-divider" aria-hidden="true" />

      {/* This session: which one, and whether it can still be joined. */}
      <nav className="session-path" aria-label="Session location">
        <Link href="/home">Sessions</Link><span aria-hidden="true">/</span><Link href={`/session/${session.id}`}><strong title={session.title}>{session.title}</strong></Link>
        {session.lockedAt != null && <span className="state-tag" data-tone="waiting" title="No new members can join">Locked</span>}
      </nav>

      {/* Where the work actually lands: the connected repo, and the branch
          agents are committing to right now (falls back to the base branch
          before a candidate branch exists). */}
      {repository && (
        <div className="repo-branch" title={`${repository.repositoryFullName}${branch ? ` @ ${branch}` : ""}`}>
          <Icon name="file" size={12} />
          <span>{repository.repositoryFullName}</span>
          {branch && (
            <>
              <Icon name="branch" size={12} />
              <code title={branch}>{abbreviatedBranch(branch)}</code>
            </>
          )}
        </div>
      )}

      <span className="topbar-divider" aria-hidden="true" />

      {/* What this session is for, how long it's been live, and when that last changed. */}
      <div className="objective-inline">
        <button type="button" className="objective-edit" title="Edit session objective" onClick={beginEditingObjective}>
          <span>{session.objective || "Add a shared objective for this session"}</span>
        </button>
        <SessionTimer base={session.activeSeconds} running={presenceConnected && session.endedAt == null} />
        <span className="objective-fact objective-fact-updated"><Icon name="clock" size={12} />Updated <LocalDateTime timestamp={session.updatedAt} mode="time" /></span>
        {session.role === "owner" && !editingObjective && staleMessageCount >= OBJECTIVE_NUDGE_THRESHOLD && (
          <span className="objective-nudge" role="status">
            {staleMessageCount} team messages since the objective was last updated.
            <button type="button" className="button" data-size="sm" onClick={beginEditingObjective}>Update objective</button>
          </span>
        )}
        {editingObjective && (
          <div className="objective-editor">
            <div className="objective-label">
              <span className="label">Session objective</span>
              <span className="value">Everyone can edit</span>
              {objectiveChangedElsewhere && <span className="objective-warning">Changed elsewhere · saving will overwrite</span>}
              {objectiveSaveState === "saving" && <span className="value">Saving…</span>}
              {objectiveSaveState === "error" && <span className="objective-error" role="alert">Not saved · click away to retry</span>}
            </div>
            <textarea
              className="objective-input"
              value={objectiveDraft}
              autoFocus
              maxLength={2000}
              aria-label="Session objective"
              onChange={(event) => setObjectiveDraft(event.target.value)}
              onBlur={() => {
                if (skipBlurSaveRef.current) {
                  skipBlurSaveRef.current = false;
                  return;
                }
                void saveObjective();
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void saveObjective();
                }
                if (event.key === "Escape") {
                  skipBlurSaveRef.current = true;
                  setObjectiveDraft(session.objective ?? "");
                  setEditingObjective(false);
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Controls: what you're looking at, who else is here, what you can do. */}
      <nav className="screen-nav" aria-label="Workspace screens">
        <button type="button" aria-pressed={screen === "workspace"} onClick={() => onScreen("workspace")}>
          Workspace{unreadTeamCount > 0 && <span className="nav-unread-dot" aria-label={`${unreadTeamCount} unread team messages`} />}
        </button>
        <button type="button" aria-pressed={screen === "review"} onClick={() => onScreen("review")}>Review{reviewAttentionCount > 0 && <span className="nav-review-badge" aria-label={`${reviewAttentionCount} conflict case${reviewAttentionCount === 1 ? "" : "s"} need attention`}>{reviewAttentionCount}</span>}</button>
      </nav>

      <div className="topbar-actions">
        {/* Offline members lead (left), online trail (right, nearest Invite) —
            tone is computed from the unsorted list first so it stays stable
            per person regardless of who else is online right now. */}
        <div className="presence" aria-label={`${members.filter((member) => member.online).length} people online`}>
          {members
            .map((member, index) => ({ member, tone: member.id === user.id ? "you" : `member-${index}` }))
            .slice(0, 5)
            .sort((a, b) => Number(a.member.online) - Number(b.member.online))
            .map(({ member, tone }) => (
              <Avatar key={member.id} userId={member.id} initials={initials(member.displayName)} tone={tone} online={member.online} />
            ))}
        </div>
        {session.role === "owner" && (
          <button type="button" ref={inviteButtonRef} className="button invite-button" onClick={() => setInviting(true)}>
            <Icon name="plus" />Invite
          </button>
        )}
        <AccountMenu user={user} />
      </div>

      {inviting && <InviteDialog session={session} members={members} onNotice={onNotice} onClose={closeInvite} />}
    </header>
  );
});

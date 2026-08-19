"use client";

import { useEffect, useId, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { SessionMember, SessionSummary } from "@/lib/session-types";
import { Avatar, Icon, useDialogDismiss } from "./primitives";

export function InviteDialog({
  session,
  members,
  onNotice,
  onClose,
}: {
  session: SessionSummary;
  members: SessionMember[];
  onNotice: (notice: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [inviteUrl, setInviteUrl] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch(`${BASE_PATH}/api/sessions/${session.id}/invite`, { cache: "no-store" })
      .then((response) => response.json() as Promise<{ inviteUrl: string | null }>)
      .then((body) => setInviteUrl(body.inviteUrl));
  }, [session.id]);

  async function rotateInvite() {
    setBusy(true);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/invite`, { method: "POST" });
    const body = (await response.json()) as { inviteUrl?: string };
    setInviteUrl(body.inviteUrl ?? null);
    setBusy(false);
    onNotice("A new invite link is active");
  }

  async function revokeInvite() {
    setBusy(true);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/invite`, { method: "DELETE" });
    if (response.ok) {
      setInviteUrl(null);
      onNotice("Invite link revoked");
    }
    setBusy(false);
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    onNotice("Invite link copied");
  }

  return (
    <dialog className="dialog invite-dialog" {...dialogProps} aria-labelledby={titleId}>
      <div className="dialog-head">
        <div className="dialog-title"><h2 id={titleId}>Invite to session</h2><p>The active link is reusable until you rotate or revoke it.</p></div>
        <button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button>
      </div>
      <div className="dialog-body">
        <div className="field">
          <span className="label">Share link</span>
          {inviteUrl === undefined ? (
            <p className="invite-loading">Loading invite…</p>
          ) : inviteUrl ? (
            <div className="invite-link-row">
              <input className="field-mono" value={inviteUrl} readOnly aria-label="Session invite link" onFocus={(event) => event.currentTarget.select()} />
              <button type="button" className="button" data-size="sm" onClick={copyInvite}>Copy link</button>
            </div>
          ) : <p className="invite-loading">No active invite link.</p>}
          <div className="button-row">
            <button type="button" className="button" onClick={rotateInvite} disabled={busy}>{inviteUrl ? "Rotate link" : "Create link"}</button>
            {inviteUrl && <button type="button" className="button danger-button" onClick={revokeInvite} disabled={busy}>Revoke</button>}
          </div>
        </div>
        <div className="field">
          <span className="label">Already in this session</span>
          <ul className="invite-members">
            {members.map((member, index) => (
              <li key={member.id}><Avatar initials={initials(member.displayName)} tone={`member-${index}`} online={member.online} />{member.displayName}<span className="value">{member.role}</span></li>
            ))}
          </ul>
        </div>
      </div>
      <div className="dialog-foot"><button type="button" className="button" data-variant="quiet" onClick={dismiss}>Done</button></div>
    </dialog>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { participants, sessionTitle } from "./data";
import { Avatar, Icon } from "./primitives";

export function InviteDialog({ onNotice, onClose }: { onNotice: (notice: string) => void; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);

  const inviteUrl = `https://opnflr.com/app/session/${sessionTitle.toLowerCase().replace(/\s+/g, "-")}`;

  // Modal mode gives us the top layer, focus containment, and Escape for free.
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  function copyLink() {
    onNotice("Invite link copied to clipboard");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    onNotice(`Invite sent to ${email}`);
    onClose();
  }

  return (
    <dialog className="dialog invite-dialog" ref={dialogRef} aria-labelledby={titleId} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div className="dialog-title">
            <h2 id={titleId}>Invite to session</h2>
            <p>Anyone with the link joins {sessionTitle} live.</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="dialog-body">
          <div className="field">
            <span className="label">Share link</span>
            <div className="invite-link-row">
              <input
                className="field-mono"
                value={inviteUrl}
                readOnly
                aria-label="Session invite link"
                onFocus={(event) => event.currentTarget.select()}
              />
              <button type="button" className="button" data-size="sm" onClick={copyLink}>
                {copied && <Icon name="check" size={12} />}
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          </div>

          <label className="field">
            <span className="label">Invite by email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teammate@company.com"
              required
            />
          </label>

          <div className="field">
            <span className="label">Already in this session</span>
            <ul className="invite-members">
              {participants.map((person) => (
                <li key={person.id}>
                  <Avatar initials={person.initials} tone={person.tone} />
                  {person.name}
                  {person.id === "ali" && <span className="invite-you">You</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="dialog-foot">
          <button type="button" className="button" data-variant="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" data-variant="primary">
            Send invite
          </button>
        </div>
      </form>
    </dialog>
  );
}

"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import type { CreateFloorAgentInput, FloorParticipant } from "@/lib/floor-types";
import { Icon, useDialogDismiss } from "./primitives";
import { SelectMenu } from "./SelectMenu";

export function CreateAgentDialog({
  onCreate,
  onClose,
  participants,
  currentUserId,
}: {
  onCreate: (input: CreateFloorAgentInput) => Promise<boolean>;
  onClose: () => void;
  participants: FloorParticipant[];
  currentUserId: string;
}) {
  const titleId = useId();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [task, setTask] = useState("");
  const [ownerUserId, setOwnerUserId] = useState(currentUserId);
  const [submitting, setSubmitting] = useState(false);
  const ready = name.trim().length > 0 && role.trim().length > 0 && task.trim().length > 0 && ownerUserId.length > 0;

  useEffect(() => { nameRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    const created = await onCreate({ name, role, task, ownerUserId });
    setSubmitting(false);
    if (created) dismiss();
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby={titleId}>
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div className="dialog-title">
            <h2 id={titleId}>New agent</h2>
            <p>Name the agent, its role, and its task. It starts working once an agent runtime is connected.</p>
          </div>
          <button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="dialog-body">
          <label className="field"><span className="label">Name</span><input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} required maxLength={24} /></label>
          <label className="field"><span className="label">Role</span><input value={role} onChange={(event) => setRole(event.target.value)} required maxLength={80} /></label>
          <label className="field"><span className="label">Task</span><textarea value={task} onChange={(event) => setTask(event.target.value)} required maxLength={1000} rows={4} /></label>
          <div className="field">
            <span className="label">Owner</span>
            <SelectMenu
              label="Agent owner"
              value={ownerUserId}
              onChange={setOwnerUserId}
              options={participants.map((person) => ({ value: person.id, label: `${person.name}${person.isCurrentUser ? " (You)" : ""}` }))}
            />
          </div>
        </div>
        <div className="dialog-foot">
          <button type="button" className="button" data-variant="quiet" onClick={dismiss}>Cancel</button>
          <button type="submit" className="button" data-variant="primary" disabled={!ready || submitting}>{submitting ? "Creating…" : "Create agent"}</button>
        </div>
      </form>
    </dialog>
  );
}

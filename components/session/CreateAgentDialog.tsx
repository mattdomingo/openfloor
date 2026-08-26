"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import type { CreateFloorAgentInput, FloorParticipant } from "@/lib/floor-types";
import {
  AGENT_PROVIDER_LABELS,
  credentialKindsForProvider,
  parseCredentialKind,
  parseCredentialProvider,
  providerLabel,
  PROVIDER_MODELS,
  type CredentialKind,
  type CredentialProvider,
} from "@/lib/provider-credentials";
import { Icon, Spinner, useDialogDismiss } from "./primitives";
import { SelectMenu } from "./SelectMenu";

export function CreateAgentDialog({
  onCreate,
  onClose,
  participants,
  currentUserId,
  enabledProviders,
}: {
  onCreate: (input: CreateFloorAgentInput) => Promise<boolean>;
  onClose: () => void;
  participants: FloorParticipant[];
  currentUserId: string;
  enabledProviders: CredentialProvider[];
}) {
  const titleId = useId();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [task, setTask] = useState("");
  const [ownerUserId, setOwnerUserId] = useState(currentUserId);
  // ponytail: the Provider select renders only when more than one provider is
  // enabled, so this initial value has to be right on its own — with exactly
  // one enabled provider a bare "openai" literal could never be corrected and
  // the POST would 503 at the rollout gate.
  const [provider, setProvider] = useState<CredentialProvider>(enabledProviders[0] ?? "openai");
  // null = "the owner's default" (api_key when connected). Offered only for
  // providers with more than one credential kind; switching provider resets
  // it so a kind can never outlive a provider that does not accept it.
  const [credentialKind, setCredentialKind] = useState<CredentialKind | null>(null);
  // null = "the provider's default". Re-keys off the provider exactly like
  // Billing above, so a model id can never be posted to another provider.
  const [model, setModel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = name.trim().length > 0 && role.trim().length > 0 && task.trim().length > 0 && ownerUserId.length > 0;

  useEffect(() => { nameRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    const created = await onCreate({ name, role, task, ownerUserId, provider, credentialKind, model });
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
          {enabledProviders.length > 1 && (
            <div className="field">
              <span className="label">Provider</span>
              <SelectMenu
                label="Agent provider"
                value={provider}
                onChange={(value) => {
                  setProvider(parseCredentialProvider(value) ?? "openai");
                  setCredentialKind(null);
                  setModel(null);
                }}
                options={enabledProviders.map((option) => ({
                  value: option,
                  label: `${AGENT_PROVIDER_LABELS[option]} (${providerLabel(option)})`,
                }))}
              />
            </div>
          )}
          <div className="field">
            <span className="label">Model</span>
            <SelectMenu
              label="Agent model"
              value={model ?? "default"}
              onChange={(value) => setModel(value === "default" ? null : value)}
              options={[
                { value: "default", label: "Provider default" },
                ...PROVIDER_MODELS[provider].map((id) => ({ value: id, label: id })),
              ]}
            />
          </div>
          {credentialKindsForProvider(provider).length > 1 && (
            <div className="field">
              <span className="label">Billing</span>
              <SelectMenu
                label="Agent billing credential"
                value={credentialKind ?? "default"}
                onChange={(value) => setCredentialKind(parseCredentialKind(value))}
                options={[
                  { value: "default", label: "Owner's default" },
                  { value: "oauth", label: "Subscription" },
                  { value: "api_key", label: "API key" },
                ]}
              />
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="button" data-variant="quiet" onClick={dismiss}>Cancel</button>
          <button type="submit" className="button" data-variant="primary" disabled={!ready || submitting}>{submitting ? <><Spinner />Creating…</> : "Create agent"}</button>
        </div>
      </form>
    </dialog>
  );
}

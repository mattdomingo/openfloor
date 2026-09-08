"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import type { CreateFloorAgentInput } from "@/lib/floor-types";
import {
  AGENT_PROVIDER_LABELS,
  connectedKindsForProvider,
  connectedProviders,
  parseCredentialKind,
  parseCredentialProvider,
  providerLabel,
  PROVIDER_MODELS,
  type CredentialKind,
  type CredentialProvider,
  type ProviderCredentialSummary,
} from "@/lib/provider-credentials";
import { HoverTip, Icon, Spinner, useDialogDismiss, useHoverTip } from "./primitives";
import { SelectMenu } from "./SelectMenu";

const AGENT_DESCRIPTION_HELP = "Standing instructions the agent follows across prompts, like a system prompt.";

export function CreateAgentDialog({
  sessionId,
  onCreate,
  onClose,
  currentUserId,
  enabledProviders,
  providerCredentials,
}: {
  sessionId: string;
  onCreate: (input: CreateFloorAgentInput) => Promise<boolean>;
  onClose: () => void;
  currentUserId: string;
  enabledProviders: CredentialProvider[];
  providerCredentials: ProviderCredentialSummary[];
}) {
  const titleId = useId();
  const descriptionId = useId();
  const descriptionHelpId = useId();
  const descriptionTip = useHoverTip();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  // Only the current user's own connected keys — an agent's owner pays for
  // its runs, but the create dialog only ever creates agents billed against
  // whoever is using it right now, never a teammate's key by proxy.
  const available = connectedProviders(providerCredentials, enabledProviders);
  // The Provider select renders only when more than one option exists, so
  // this initial value has to be right on its own: null means "no connected
  // provider" and disables Create outright (there is no server fallback key).
  const [provider, setProvider] = useState<CredentialProvider | null>(available[0] ?? null);
  // null = "the owner's default" (api_key when connected). Offered only for
  // providers with more than one connected credential kind; switching provider
  // resets it so a kind can never outlive a provider that does not accept it.
  const [usageScope, setUsageScope] = useState<"private" | "session">("private");
  const [credentialKind, setCredentialKind] = useState<CredentialKind | null>(null);
  // null = "the provider's default". Re-keys off the provider exactly like
  // Billing above, so a model id can never be posted to another provider.
  const [model, setModel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = name.trim().length > 0 && task.trim().length > 0 && provider !== null;

  useEffect(() => { nameRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting || !provider) return;
    setSubmitting(true);
    const created = await onCreate({ name, role: "Engineer", task, ownerUserId: currentUserId, provider, credentialKind, model, usageScope });
    setSubmitting(false);
    if (created) dismiss();
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby={titleId}>
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div className="dialog-title">
            <h2 id={titleId}>New agent</h2>
            <p>Name your agent and describe its responsibilities. Work starts when a prompt is assigned.</p>
          </div>
          <button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="dialog-body">
          <label className="field"><span className="label">Name</span><input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} required maxLength={24} /></label>
          <div className="field">
            <label className="label-with-help" htmlFor={descriptionId} tabIndex={0} {...descriptionTip.handlers}>
              Description <span className="field-help-mark" aria-hidden="true">?</span>
            </label>
            <textarea id={descriptionId} aria-describedby={descriptionHelpId} value={task} onChange={(event) => setTask(event.target.value)} required maxLength={1000} rows={4} />
            <span id={descriptionHelpId} className="sr-only">{AGENT_DESCRIPTION_HELP}</span>
            <HoverTip position={descriptionTip.position} wrap>{AGENT_DESCRIPTION_HELP}</HoverTip>
          </div>
          <p className="form-note">You own this agent. Shared routing may run it and spend your connected provider credential.</p>
          {available.length === 0 ? (
            <p className="notice" data-tone="attention" role="status">
              {"No provider keys are connected. Connect one to create an agent. "}
              <Link href={`/home/settings?section=connections&from=${encodeURIComponent(`/session/${sessionId}`)}`}>
                Connect a provider
              </Link>
              .
            </p>
          ) : (
            <>
              {available.length > 1 && (
                <div className="field">
                  <span className="label">Provider</span>
                  <SelectMenu
                    label="Agent provider"
                    value={provider ?? ""}
                    onChange={(value) => {
                      setProvider(parseCredentialProvider(value));
                      setCredentialKind(null);
                      setModel(null);
                    }}
                    options={available.map((option) => ({
                      value: option,
                      label: `${AGENT_PROVIDER_LABELS[option]} (${providerLabel(option)})`,
                    }))}
                  />
                </div>
              )}
              {provider && (
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
              )}
              {provider && connectedKindsForProvider(providerCredentials, provider).length > 1 && (
                <div className="field">
                  <span className="label">Billing</span>
                  <SelectMenu
                    label="Agent billing credential"
                    value={credentialKind ?? "default"}
                    onChange={(value) => setCredentialKind(parseCredentialKind(value))}
                    options={[
                      { value: "default", label: "Owner's default" },

                      { value: "api_key", label: "API key" },
                    ]}
                  />
                </div>
              )}
            </>
          )}
        </div>
        <div className="dialog-body">
          <span className="label">Who can use this agent</span>
          <SelectMenu label="Who can use this agent" value={usageScope} onChange={(value) => setUsageScope(value as "private" | "session")} options={[{ value: "private", label: "Only me" }, { value: "session", label: "Everyone in this session" }]} />
          <p className="form-note">Sharing lets teammates run this agent using your API key.</p>
        </div>
        <div className="dialog-foot">
          <button type="button" className="button" data-variant="quiet" onClick={dismiss}>Cancel</button>
          <button type="submit" className="button" data-variant="primary" disabled={!ready || submitting}>{submitting ? <><Spinner />Creating…</> : "Create agent"}</button>
        </div>
      </form>
    </dialog>
  );
}

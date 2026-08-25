"use client";

import { FormEvent, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import {
  AGENT_PROVIDER_LABELS,
  DEFAULT_PROVIDER_MODELS,
  providerLabel,
  type CredentialProvider,
  type ProviderCredentialSummary,
} from "@/lib/provider-credentials";

export function ProviderCredentials({
  initialCredentials,
  providers,
  showAgentDefaults = false,
  onCredentialsChange,
}: {
  initialCredentials: ProviderCredentialSummary[];
  providers: CredentialProvider[];
  showAgentDefaults?: boolean;
  onCredentialsChange?: (credentials: ProviderCredentialSummary[]) => void;
}) {
  const [credentials, setCredentials] = useState(initialCredentials);

  return (
    <ul className="settings-category-list provider-credential-list">
      {providers.map((provider) => (
        <ProviderCredentialRow
          key={provider}
          provider={provider}
          credential={credentials.find((credential) => credential.provider === provider) ?? null}
          showAgentDefaults={showAgentDefaults}
          onChanged={(next) => setCredentials((current) => {
            const others = current.filter((credential) => credential.provider !== provider);
            const updated = next ? [...others, next] : others;
            onCredentialsChange?.(updated);
            return updated;
          })}
        />
      ))}
    </ul>
  );
}

function ProviderCredentialRow({ provider, credential, showAgentDefaults, onChanged }: {
  provider: CredentialProvider;
  credential: ProviderCredentialSummary | null;
  showAgentDefaults: boolean;
  onChanged: (credential: ProviderCredentialSummary | null) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/account/credentials/${provider}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey.trim() }),
    });
    const body = (await response.json().catch(() => null)) as { credential?: ProviderCredentialSummary; error?: string } | null;
    if (!response.ok || !body?.credential) {
      setError(body?.error ?? "Unable to verify that key. Try again.");
      setBusy(false);
      return;
    }
    setApiKey("");
    setBusy(false);
    onChanged(body.credential);
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/account/credentials/${provider}`, { method: "DELETE" });
    if (!response.ok) {
      setError("Unable to disconnect. Try again.");
      setBusy(false);
      return;
    }
    setBusy(false);
    onChanged(null);
  }

  return (
    <li className="settings-category-row provider-credential-row">
      <span className="settings-category-name">
        {providerLabel(provider)}
        {showAgentDefaults && <small>{AGENT_PROVIDER_LABELS[provider]} · {DEFAULT_PROVIDER_MODELS[provider]}</small>}
      </span>
      {credential ? (
        <>
          <span className="settings-category-detail">
            <strong>Connected</strong> — API key ending in ····{credential.fingerprint}.
          </span>
          <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={disconnect} disabled={busy}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        </>
      ) : (
        <form className="settings-category-detail" onSubmit={connect}>
          <label className="field">
            <span className="label">API key</span>
            <input
              aria-label={`${providerLabel(provider)} API key`}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="form-actions">
            <button className="button" data-variant="primary" data-size="sm" disabled={!apiKey.trim() || busy}>
              {busy ? "Verifying…" : "Connect"}
            </button>
          </div>
        </form>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </li>
  );
}

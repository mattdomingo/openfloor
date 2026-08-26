"use client";

import { FormEvent, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import {
  AGENT_PROVIDER_LABELS,
  credentialKindLabel,
  credentialKindsForProvider,
  DEFAULT_PROVIDER_MODELS,
  providerLabel,
  type CredentialKind,
  type CredentialProvider,
  type ProviderCredentialSummary,
} from "@/lib/provider-credentials";

// One row per (provider, kind): providers that accept a subscription
// credential alongside an API key render two independently connectable rows;
// everything else renders one, exactly as before kinds existed.
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
      {providers.flatMap((provider) =>
        credentialKindsForProvider(provider).map((kind) => (
          <ProviderCredentialRow
            key={`${provider}:${kind}`}
            provider={provider}
            kind={kind}
            credential={credentials.find((credential) => credential.provider === provider && credential.kind === kind) ?? null}
            showAgentDefaults={showAgentDefaults}
            onChanged={(next) => setCredentials((current) => {
              const others = current.filter((credential) => !(credential.provider === provider && credential.kind === kind));
              const updated = next ? [...others, next] : others;
              onCredentialsChange?.(updated);
              return updated;
            })}
          />
        )),
      )}
    </ul>
  );
}

function ProviderCredentialRow({ provider, kind, credential, showAgentDefaults, onChanged }: {
  provider: CredentialProvider;
  kind: CredentialKind;
  credential: ProviderCredentialSummary | null;
  showAgentDefaults: boolean;
  onChanged: (credential: ProviderCredentialSummary | null) => void;
}) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The connect form maps one-to-one onto the PUT body shapes: an API key,
  // a Claude setup token, or a pasted ChatGPT auth bundle (dormant while
  // openai's oauth kind is withheld pending §5).
  const bundle = provider === "openai" && kind === "oauth";
  const field = kind === "api_key" ? "apiKey" : bundle ? "authJson" : "setupToken";
  const rowName = kind === "api_key" ? providerLabel(provider) : credentialKindLabel(provider, kind);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!secret.trim() || busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/account/credentials/${provider}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: secret.trim() }),
    });
    const body = (await response.json().catch(() => null)) as { credential?: ProviderCredentialSummary; error?: string } | null;
    if (!response.ok || !body?.credential) {
      setError(body?.error ?? "Unable to verify that credential. Try again.");
      setBusy(false);
      return;
    }
    setSecret("");
    setBusy(false);
    onChanged(body.credential);
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/account/credentials/${provider}?kind=${kind}`, { method: "DELETE" });
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
        {rowName}
        {showAgentDefaults && kind === "api_key" && <small>{AGENT_PROVIDER_LABELS[provider]} · {DEFAULT_PROVIDER_MODELS[provider]}</small>}
      </span>
      {credential ? (
        <>
          <span className="settings-category-detail">
            {kind === "api_key" ? (
              <><strong>Connected</strong> — API key ending in ····{credential.fingerprint}.</>
            ) : (
              <>
                <strong>{credential.validatedAt ? "Connected" : "Connected — not yet verified"}</strong>
                {" — "}{bundle ? <>account ····{credential.fingerprint}</> : <>····{credential.fingerprint}</>}.
              </>
            )}
          </span>
          <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={disconnect} disabled={busy}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        </>
      ) : (
        <form className="settings-category-detail" onSubmit={connect}>
          {kind === "oauth" && (
            <p className="settings-category-detail">
              {bundle
                ? <>Run <code>codex login</code> on your machine, then paste the contents of <code>~/.codex/auth.json</code>.</>
                : <>Run <code>claude setup-token</code> on your machine and paste the token.</>}
              {" "}Used only for runs of agents you own; the subscription&rsquo;s rate limits are yours and apply here too.
              openfloor never uses it for anyone else, and disconnecting is immediate.
            </p>
          )}
          {bundle ? (
            <label className="field">
              <span className="label">auth.json</span>
              <textarea
                aria-label={`${providerLabel(provider)} auth.json`}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                maxLength={8192}
                rows={4}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : (
            <label className="field">
              <span className="label">{kind === "api_key" ? "API key" : "Setup token"}</span>
              <input
                aria-label={`${rowName} ${kind === "api_key" ? "API key" : "setup token"}`}
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                maxLength={512}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <div className="form-actions">
            <button className="button" data-variant="primary" data-size="sm" disabled={!secret.trim() || busy}>
              {busy ? (bundle ? "Connecting…" : "Verifying…") : "Connect"}
            </button>
          </div>
        </form>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </li>
  );
}

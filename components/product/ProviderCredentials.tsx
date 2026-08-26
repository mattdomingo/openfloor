"use client";

import { FormEvent, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import { Spinner } from "@/components/session/primitives";
import {
  AGENT_PROVIDER_LABELS,
  CONNECTION_REQUEST_EMAIL,
  CREDENTIAL_SETUP_COMMANDS,
  credentialKindLabel,
  credentialKindsForProvider,
  DEFAULT_PROVIDER_MODELS,
  PROVIDER_KEY_GUIDE,
  PROVIDER_LOGOS,
  providerLabel,
  SUBSCRIPTION_KEY_GUIDE,
  type CredentialKind,
  type CredentialProvider,
  type ProviderCredentialSummary,
} from "@/lib/provider-credentials";

// One tile per (provider, kind): providers that accept a subscription
// credential alongside an API key render two independently connectable tiles;
// everything else renders one, exactly as before kinds existed. Tiles sit in a
// grid and the open one spans the full row, so reading a key's instructions
// never reflows the tiles beside it.
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
      <li className="provider-credential-request">
        <p>Need a provider that isn&rsquo;t here? Tell us which one and we&rsquo;ll look at adding it.</p>
        <a className="button" data-variant="quiet" data-size="sm" href={`mailto:${CONNECTION_REQUEST_EMAIL}?subject=${encodeURIComponent("openfloor: model connection request")}`}>
          Request a provider
        </a>
      </li>
    </ul>
  );
}

// 80%/100% thresholds match lib/agent-run-start.ts's checkProviderBudget,
// which refuses new runs at the cap this colors red.
function budgetLevel(spendMicroUsd: number, limitMicroUsd: number | null): "ok" | "warn" | "over" {
  if (limitMicroUsd === null || limitMicroUsd === 0) return "ok";
  const ratio = spendMicroUsd / limitMicroUsd;
  if (ratio >= 1) return "over";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
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
  const panelId = `credential-panel-${provider}-${kind}`;
  // Every tile starts collapsed. Opening the unconnected ones by default was
  // right when this was a single column, but an open tile spans the grid row,
  // so with five providers it collapsed the whole layout back into a list.
  const [expanded, setExpanded] = useState(false);
  const guide = PROVIDER_KEY_GUIDE[provider];
  const setupCommand = CREDENTIAL_SETUP_COMMANDS[`${provider}:${kind}`];
  // A console-minted subscription credential (no CLI command) is pasted from
  // the plan's own console — a different page than the PAYG key console —
  // and the vendor calls it an API key, so the field label follows.
  const subscriptionGuide = SUBSCRIPTION_KEY_GUIDE[provider] ?? guide;
  const oauthNoun = setupCommand ? "Setup token" : "API key";

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

  async function saveLimit(monthlyLimitUsd: number | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/account/credentials/${provider}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, monthlyLimitUsd }),
    });
    const body = (await response.json().catch(() => null)) as { credential?: ProviderCredentialSummary; error?: string } | null;
    setBusy(false);
    if (!response.ok || !body?.credential) {
      setError(body?.error ?? "Unable to save that limit. Try again.");
      return;
    }
    onChanged(body.credential);
  }

  return (
    <li className="settings-category-row provider-credential-row" data-expanded={expanded}>
      <button
        type="button"
        className="provider-credential-toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        <ProviderMark provider={provider} />
        <span className="settings-category-name">
          {rowName}
          {showAgentDefaults && kind === "api_key" && <small>{AGENT_PROVIDER_LABELS[provider]} · {DEFAULT_PROVIDER_MODELS[provider]}</small>}
        </span>
        <span className="provider-credential-status" data-connected={Boolean(credential)}>
          {credential ? (kind === "api_key" || credential.validatedAt ? "Connected" : "Connected — not yet verified") : "Not connected"}
        </span>
      </button>
      {expanded && (
        <div id={panelId} className="provider-credential-body">
          {credential ? (
            <>
              {/* .settings-category-row .button (globals.css) grid-places the
                  Disconnect button at "row 1 / span 2" beside this block,
                  assuming exactly two grid children — so the fingerprint line
                  and the budget control are wrapped together into ONE child
                  here rather than added as a third sibling, which would
                  otherwise steal the row the button expects to span. */}
              <div className="provider-credential-detail">
                <span className="settings-category-detail">
                  {kind === "api_key" ? (
                    <>API key ending in ····{credential.fingerprint}.</>
                  ) : (
                    <>{bundle ? <>account ····{credential.fingerprint}</> : <>····{credential.fingerprint}</>}.</>
                  )}
                </span>
                <ProviderBudgetControl credential={credential} busy={busy} onSaveLimit={saveLimit} />
              </div>
              <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={disconnect} disabled={busy}>
                {busy ? <><Spinner />Disconnecting…</> : "Disconnect"}
              </button>
            </>
          ) : (
            <form className="settings-category-detail" onSubmit={connect}>
              {kind === "oauth" ? (
                <>
                  <p className="settings-category-detail">
                    {bundle
                      ? <>Run this on your machine, then paste the contents of <code>~/.codex/auth.json</code>.</>
                      : setupCommand
                        ? <>Run this on your machine and paste the token it prints.</>
                        : <>Create a key in the <a href={subscriptionGuide.consoleUrl} target="_blank" rel="noreferrer noopener">{subscriptionGuide.consoleLabel}</a> — the plan&rsquo;s own console, not the pay-as-you-go key page — and paste it here.</>}
                    {" "}Used only for runs of agents you own; the subscription&rsquo;s rate limits are yours and apply here too.
                    openfloor never uses it for anyone else, and disconnecting is immediate.
                  </p>
                  {setupCommand && <CopyCommand command={setupCommand} />}
                </>
              ) : (
                <p className="settings-category-detail">
                  Create a key in the <a href={guide.consoleUrl} target="_blank" rel="noreferrer noopener">{guide.consoleLabel}</a>, then paste it here.
                  It is encrypted on arrival and never sent back to the browser.
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
                  <span className="label">{kind === "api_key" ? "API key" : oauthNoun}</span>
                  <input
                    aria-label={`${rowName} ${kind === "api_key" ? "API key" : oauthNoun.toLowerCase()}`}
                    type="password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder={kind === "api_key" ? guide.placeholder : undefined}
                    maxLength={512}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
              <div className="form-actions">
                <button className="button" data-variant="primary" data-size="sm" disabled={!secret.trim() || busy}>
                  {busy ? <><Spinner />{bundle ? "Connecting…" : "Verifying…"}</> : "Connect"}
                </button>
              </div>
            </form>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      )}
    </li>
  );
}

// This-UTC-month spend against an owner-set cap (null = uncapped). Warns at
// 80%, matches red at 100% — lib/agent-run-start.ts's checkProviderBudget
// refuses new runs at that same 100% line.
function ProviderBudgetControl({ credential, busy, onSaveLimit }: {
  credential: ProviderCredentialSummary;
  busy: boolean;
  onSaveLimit: (monthlyLimitUsd: number | null) => void;
}) {
  const hasLimit = credential.monthlyLimitMicroUsd !== null;
  const [editing, setEditing] = useState(false);
  const [limitInput, setLimitInput] = useState(
    hasLimit ? String((credential.monthlyLimitMicroUsd as number) / 1_000_000) : "",
  );
  const level = budgetLevel(credential.monthSpendMicroUsd, credential.monthlyLimitMicroUsd);

  function submitLimit(event: FormEvent) {
    event.preventDefault();
    const trimmed = limitInput.trim();
    if (!trimmed) {
      onSaveLimit(null);
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0) return;
      onSaveLimit(parsed);
    }
    setEditing(false);
  }

  return (
    <div className="provider-budget">
      <div className="provider-budget-line">
        <span>This month: {formatUsd(credential.monthSpendMicroUsd)}{hasLimit ? ` of ${formatUsd(credential.monthlyLimitMicroUsd as number)}` : ""}</span>
        <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => setEditing((value) => !value)} disabled={busy}>
          {hasLimit ? "Change limit" : "Set limit"}
        </button>
      </div>
      <progress
        className="usage-meter"
        data-level={level}
        value={hasLimit ? Math.min(credential.monthSpendMicroUsd, credential.monthlyLimitMicroUsd as number) : credential.monthSpendMicroUsd}
        max={hasLimit ? (credential.monthlyLimitMicroUsd as number) : Math.max(credential.monthSpendMicroUsd, 1)}
        aria-label={`This month's spend${hasLimit ? `, against a ${formatUsd(credential.monthlyLimitMicroUsd as number)} monthly limit` : ""}`}
      />
      {editing && (
        <form className="provider-budget-form" onSubmit={submitLimit}>
          <label className="field">
            <span className="label">Monthly limit (USD, blank for none)</span>
            <input
              type="number"
              min={0}
              step="1"
              inputMode="numeric"
              value={limitInput}
              onChange={(event) => setLimitInput(event.target.value)}
              placeholder="No limit"
              aria-label="Monthly limit in US dollars"
            />
          </label>
          <div className="form-actions">
            <button className="button" data-variant="primary" data-size="sm" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      )}
    </div>
  );
}

/* The vendor mark, or its initial where public/logos has no file yet. The
   image is decorative — the tile's own name is the accessible label — so its
   alt stays empty rather than repeating that name to a screen reader. */
function ProviderMark({ provider }: { provider: CredentialProvider }) {
  const logo = PROVIDER_LOGOS[provider];
  return (
    <span className="provider-credential-mark" aria-hidden="true">
      {logo
        // eslint-disable-next-line @next/next/no-img-element -- a fixed 22px vendor mark; next/image would add a loader round trip for a static SVG
        ? <img src={`${BASE_PATH}${logo}`} alt="" width={22} height={22} />
        : <span className="provider-credential-monogram">{providerLabel(provider).slice(0, 1)}</span>}
    </span>
  );
}

/* "Copy this to your agent": the command that mints a subscription token is
   meant to be pasted into a terminal, so it gets a copy button rather than
   being read out of a sentence. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="provider-credential-command">
      <code>{command}</code>
      <button
        type="button"
        className="button"
        data-variant="quiet"
        data-size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
          } catch {
            // Clipboard access can be refused (insecure origin, denied
            // permission); the command is on screen either way.
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

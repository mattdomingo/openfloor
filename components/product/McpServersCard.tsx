"use client";

import { FormEvent, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import { SelectMenu } from "@/components/session/SelectMenu";
import { useDialogDismiss } from "@/components/session/primitives";
import type { SessionMcpServerSummary } from "@/db/mcp-servers";

// Session-configured remote MCP servers for Claude runs (v1: http/sse only).
// Members see the list; only the owner mutates. Header values are write-only
// — the API returns names, never values. Rendered only while
// CLAUDE_RUN_ENABLED is on.
export function McpServersCard({ sessionId, role, initialServers }: {
  sessionId: string;
  role: "owner" | "member";
  initialServers: SessionMcpServerSummary[];
}) {
  const [servers, setServers] = useState(initialServers);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function mutate(serverId: string, method: "PATCH" | "DELETE", body?: unknown) {
    if (busyId) return;
    setBusyId(serverId);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/mcp-servers/${serverId}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as { servers?: SessionMcpServerSummary[]; error?: string } | null;
    if (!response.ok || !payload?.servers) {
      setError(payload?.error ?? "Unable to update that server. Try again.");
    } else {
      setServers(payload.servers);
    }
    setBusyId(null);
  }

  return (
    <section className="action-card" aria-label="MCP servers">
      <p className="eyebrow">MCP servers</p>
      <h2>Connected tools</h2>
      <p>
        Remote MCP servers this session&rsquo;s Claude agents can call. An agent sends session content directly to each
        enabled server, so add only hosts you trust. The built-in <code>openfloor</code> session-context tool is always
        present.
      </p>
      {role === "owner" && (
        <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => setAdding(true)}>Add server</button>
      )}
      {servers.length === 0 ? (
        <p>No servers configured.</p>
      ) : (
        <ul className="settings-category-list">
          {servers.map((server) => (
            <li key={server.id} className="settings-category-row">
              <span className="settings-category-name">{server.name}</span>
              <span className="settings-category-detail">
                {server.transport.toUpperCase()} · {server.url}
                {server.headerNames.length > 0 && <> · headers: {server.headerNames.join(", ")}</>}
                {!server.enabled && <> · <strong>disabled</strong></>}
              </span>
              {role === "owner" && (
                <span className="settings-category-detail">
                  <button type="button" className="button" data-variant="quiet" data-size="sm" disabled={busyId !== null}
                    onClick={() => mutate(server.id, "PATCH", { enabled: !server.enabled })}>
                    {server.enabled ? "Disable" : "Enable"}
                  </button>{" "}
                  <button type="button" className="button" data-variant="quiet" data-size="sm" disabled={busyId !== null}
                    onClick={() => mutate(server.id, "DELETE")}>
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {adding && (
        <AddMcpServerDialog
          sessionId={sessionId}
          onClose={() => setAdding(false)}
          onAdded={(next) => {
            setServers(next);
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}

function AddMcpServerDialog({ sessionId, onClose, onAdded }: {
  sessionId: string;
  onClose: () => void;
  onAdded: (servers: SessionMcpServerSummary[]) => void;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = name.trim().length > 0 && url.trim().length > 0;

  function parseHeaderLines(): Record<string, string> | null | undefined {
    const lines = headersText.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const separator = line.indexOf(":");
      if (separator <= 0) return undefined;
      headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return headers;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    const headers = parseHeaderLines();
    if (headers === undefined) {
      setError("Headers must be one Header-Name: value per line.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), transport, url: url.trim(), headers }),
    });
    const body = (await response.json().catch(() => null)) as { servers?: SessionMcpServerSummary[]; error?: string } | null;
    if (!response.ok || !body?.servers) {
      setError(body?.error ?? "Unable to add that server. Try again.");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    onAdded(body.servers);
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="add-mcp-title">
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div className="dialog-title">
            <h2 id="add-mcp-title">Add an MCP server</h2>
            <p>Remote servers only, over HTTPS. Header values are stored encrypted and never shown again.</p>
          </div>
        </div>
        <div className="dialog-body">
          <label className="field"><span className="label">Name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} required spellCheck={false} /></label>
          <div className="field">
            <span className="label">Transport</span>
            <SelectMenu
              label="MCP transport"
              value={transport}
              onChange={(value) => setTransport(value === "sse" ? "sse" : "http")}
              options={[{ value: "http", label: "HTTP" }, { value: "sse", label: "SSE" }]}
            />
          </div>
          <label className="field"><span className="label">URL</span><input value={url} onChange={(event) => setUrl(event.target.value)} maxLength={2048} required spellCheck={false} inputMode="url" /></label>
          <label className="field">
            <span className="label">Headers <em>optional</em></span>
            <textarea value={headersText} onChange={(event) => setHeadersText(event.target.value)} rows={3} spellCheck={false} placeholder={"Authorization: Bearer …"} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={submitting}>Cancel</button>
          <button type="submit" className="button" data-variant="primary" disabled={!ready || submitting}>{submitting ? "Adding…" : "Add server"}</button>
        </div>
      </form>
    </dialog>
  );
}

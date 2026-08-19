"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import type {
  GitHubRepositoryOption,
  RepositoryConnection,
  SessionRole,
} from "@/lib/session-types";

type OptionsResponse = { repositories: GitHubRepositoryOption[]; branches: string[]; error?: string };

async function readResponse<T extends { error?: string }>(response: Response): Promise<Partial<T>> {
  const text = await response.text();
  if (!text) return { error: `OpenFloor returned an empty response (${response.status})` } as Partial<T>;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: `OpenFloor returned an invalid response (${response.status})` } as Partial<T>;
  }
}

export function RepositoryCard({
  sessionId,
  role,
  initialRepository,
  beginSetup,
}: {
  sessionId: string;
  role: SessionRole;
  initialRepository: RepositoryConnection | null;
  beginSetup: boolean;
}) {
  const router = useRouter();
  const [repository, setRepository] = useState(initialRepository);
  const [editing, setEditing] = useState(beginSetup);
  const [repositories, setRepositories] = useState<GitHubRepositoryOption[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [repositoryId, setRepositoryId] = useState(initialRepository?.repositoryId ?? "");
  const [baseBranch, setBaseBranch] = useState(initialRepository?.baseBranch ?? "");
  const [commands, setCommands] = useState(initialRepository?.checkCommands.map((item) => item.command).join("\n") ?? "");
  const [busy, setBusy] = useState(beginSetup);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedRepository = useMemo(
    () => repositories.find((item) => item.id === repositoryId) ?? null,
    [repositories, repositoryId],
  );

  const loadOptions = useCallback(async (selectedId?: string) => {
    const query = selectedId ? `?repositoryId=${encodeURIComponent(selectedId)}` : "";
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/options${query}`, { cache: "no-store" });
    const body = await readResponse<OptionsResponse>(response);
    if (!response.ok) throw new Error(body.error ?? "Unable to load GitHub repositories");
    if (!body.repositories || !body.branches) throw new Error(body.error ?? "GitHub repository options are incomplete");
    setRepositories(body.repositories);
    setBranches(body.branches);
    return { repositories: body.repositories, branches: body.branches };
  }, [sessionId]);

  useEffect(() => {
    if (!editing || role !== "owner") return;
    let disposed = false;
    void (async () => {
      const initial = await loadOptions();
      const selected = initial.repositories.find((item) => item.id === repositoryId) ?? initial.repositories[0];
      if (!selected) throw new Error("The GitHub App installation has no available repositories");
      if (disposed) return;
      setRepositoryId(selected.id);
      const branchOptions = await loadOptions(selected.id);
      if (disposed) return;
      if (!baseBranch || !branchOptions.branches.includes(baseBranch)) {
        setBaseBranch(branchOptions.branches.includes(selected.defaultBranch) ? selected.defaultBranch : branchOptions.branches[0] ?? "");
      }
    })()
      .catch((reason: unknown) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : "Unable to load GitHub repositories");
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => { disposed = true; };
    // Editing intentionally snapshots the current form values when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, loadOptions, role]);

  async function connect() {
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/connect`, { method: "POST" });
    const body = await readResponse<{ installUrl?: string; error?: string }>(response);
    if (!response.ok || !body.installUrl) {
      setError(body.error ?? "Unable to begin GitHub setup");
      setBusy(false);
      return;
    }
    window.location.assign(body.installUrl);
  }

  async function chooseRepository(nextId: string) {
    setRepositoryId(nextId);
    setBusy(true);
    setError(null);
    try {
      const body = await loadOptions(nextId);
      const selected = body.repositories.find((item) => item.id === nextId);
      setBaseBranch(selected?.defaultBranch ?? body.branches[0] ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load repository branches");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const checkCommands = commands.split("\n").map((command) => command.trim()).filter(Boolean);
    setBusy(true);
    setError(null);
    const method = beginSetup || repository?.status === "disconnected" || !repository ? "POST" : "PATCH";
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryId, baseBranch, checkCommands }),
    });
    const body = await readResponse<{ repository?: RepositoryConnection; error?: string }>(response);
    if (!response.ok || !body.repository) {
      setError(body.error ?? "Unable to save the repository connection");
      setBusy(false);
      return;
    }
    setRepository(body.repository);
    setCommands(body.repository.checkCommands.map((item) => item.command).join("\n"));
    setEditing(false);
    setBusy(false);
    setNotice("GitHub repository connected.");
    router.replace(`/session/${sessionId}`);
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository`, { method: "DELETE" });
    const body = await readResponse<{ repository?: RepositoryConnection; error?: string }>(response);
    if (!response.ok || !body.repository) {
      setError(body.error ?? "Unable to disconnect the repository");
    } else {
      setRepository(body.repository);
      setEditing(false);
      setNotice("Repository disconnected. No GitHub content was changed.");
    }
    setBusy(false);
  }

  function edit() {
    setRepositoryId(repository?.repositoryId ?? "");
    setBaseBranch(repository?.baseBranch ?? "");
    setCommands(repository?.checkCommands.map((item) => item.command).join("\n") ?? "");
    setBusy(true);
    setEditing(true);
    setNotice(null);
    setError(null);
  }

  return (
    <section className="action-card repository-card" aria-label="GitHub repository">
      <p className="eyebrow">Repository</p>
      <h2>GitHub connection</h2>
      {!repository && !editing && (
        <>
          <p>No repository is connected. Agent execution remains unavailable.</p>
          {role === "owner" && <button className="button" data-variant="primary" onClick={connect} disabled={busy}>Connect GitHub</button>}
        </>
      )}
      {repository && !editing && (
        <>
          <div className="repository-summary">
            <strong>{repository.repositoryFullName}</strong>
            <span>{repository.repositoryPrivate ? "Private" : "Public"} · base <code>{repository.baseBranch}</code></span>
            <span data-status={repository.status}>{repository.status}</span>
          </div>
          <div className="repository-checks">
            <span>Required checks</span>
            {repository.checkCommands.length > 0
              ? <ol>{repository.checkCommands.map((item) => <li key={item.id}><code>{item.command}</code></li>)}</ol>
              : <p>Not configured</p>}
          </div>
          {role === "owner" && (
            <div className="button-row">
              {repository.status === "connected" ? (
                <>
                  <button className="button" onClick={edit} disabled={busy}>Configure</button>
                  <button className="button danger-button" onClick={disconnect} disabled={busy}>Disconnect</button>
                </>
              ) : <button className="button" data-variant="primary" onClick={connect} disabled={busy}>Reconnect GitHub</button>}
            </div>
          )}
        </>
      )}
      {editing && role === "owner" && (
        <div className="repository-form">
          <label>
            <span>Repository</span>
            <select aria-label="Connected repository" value={repositoryId} onChange={(event) => void chooseRepository(event.target.value)} disabled={busy}>
              {repositories.map((item) => <option key={item.id} value={item.id}>{item.fullName}</option>)}
            </select>
          </label>
          <label>
            <span>Base branch</span>
            <select aria-label="Repository base branch" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} disabled={busy || branches.length === 0}>
              {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          </label>
          <label>
            <span>Required check commands</span>
            <textarea aria-label="Required check commands" value={commands} onChange={(event) => setCommands(event.target.value)} rows={4} />
            <small>Optional while connecting. Enter one shell command per line; execution will require checks to be configured first.</small>
          </label>
          <div className="button-row">
            <button className="button" data-variant="primary" onClick={save} disabled={busy || !selectedRepository || !baseBranch}>Save repository</button>
            {!beginSetup && repository?.status === "connected" && <button className="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>}
          </div>
        </div>
      )}
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

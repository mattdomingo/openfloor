"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import { SelectMenu } from "@/components/session/SelectMenu";
import type {
  AccountGitHubRepositoryOption,
  GitHubRepositoryOption,
  RepositoryCandidate,
  RepositoryConnection,
  RepositoryConnectionStatus,
  RepositoryPreflight,
  SessionRole,
} from "@/lib/session-types";

type RepositoryOption = GitHubRepositoryOption | AccountGitHubRepositoryOption;
type OptionsResponse = { repositories: RepositoryOption[]; branches: string[]; error?: string };

const connectionStatusLabel: Record<RepositoryConnectionStatus, string> = {
  connected: "Connected",
  ready: "Ready",
  revoked: "Access revoked",
  inaccessible: "Inaccessible",
  externally_modified: "Modified outside openfloor",
  disconnected: "Disconnected",
};

// For enum-ish statuses that are readable once the underscores go.
function humanize(status: string) {
  return status.replaceAll("_", " ");
}

async function readResponse<T extends { error?: string }>(response: Response): Promise<Partial<T>> {
  const text = await response.text();
  if (!text) return { error: `Something went wrong (${response.status}). Try again.` } as Partial<T>;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: `Something went wrong (${response.status}). Try again.` } as Partial<T>;
  }
}

export function RepositoryCard({
  sessionId,
  sessionTitle,
  sessionObjective,
  role,
  initialRepository,
  initialCandidate,
  initialPreflight,
  preflightEnabled,
  beginSetup,
  onStateChange,
}: {
  sessionId: string;
  sessionTitle: string;
  sessionObjective: string | null;
  role: SessionRole;
  initialRepository: RepositoryConnection | null;
  initialCandidate: RepositoryCandidate | null;
  initialPreflight: RepositoryPreflight | null;
  preflightEnabled: boolean;
  beginSetup: boolean;
  onStateChange?: (state: { repository: RepositoryConnection | null; candidate: RepositoryCandidate | null }) => void;
}) {
  const [repository, setRepository] = useState(initialRepository);
  const [candidate, setCandidate] = useState(initialCandidate);
  const [preflight, setPreflight] = useState(initialPreflight);
  const [logs, setLogs] = useState<string | null>(null);
  const [editing, setEditing] = useState(beginSetup);
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setRepository(initialRepository);
      setCandidate(initialCandidate);
      setPreflight(initialPreflight);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialCandidate, initialPreflight, initialRepository]);

  useEffect(() => {
    if (!preflight || !["provisioning", "running"].includes(preflight.status)) return;
    const timer = window.setInterval(() => {
      void fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/preflight`, { cache: "no-store" })
        .then((response) => response.json() as Promise<{ preflight?: RepositoryPreflight }>)
        .then((body) => { if (body.preflight) setPreflight(body.preflight); });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [preflight, sessionId]);

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
      body: JSON.stringify({
        repositoryId,
        baseBranch,
        checkCommands,
        ...(selectedRepository && "accountInstallationId" in selectedRepository
          ? { accountInstallationId: selectedRepository.accountInstallationId }
          : {}),
      }),
    });
    const body = await readResponse<{
      repository?: RepositoryConnection;
      candidate?: RepositoryCandidate | null;
      setupStatus?: "ready" | "failed";
      error?: string;
    }>(response);
    if (!response.ok || !body.repository) {
      setError(body.error ?? "Unable to save the repository connection");
      setBusy(false);
      return;
    }
    setRepository(body.repository);
    onStateChange?.({ repository: body.repository, candidate });
    setCommands(body.repository.checkCommands.map((item) => item.command).join("\n"));
    setEditing(false);
    setBusy(false);
    setCandidate(body.candidate ?? candidate);
    onStateChange?.({ repository: body.repository, candidate: body.candidate ?? candidate });
    setNotice(body.setupStatus === "failed" ? "Repository saved, but candidate setup needs retry." : "GitHub repository ready.");
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
      onStateChange?.({ repository: body.repository, candidate });
      setEditing(false);
      setNotice("Repository disconnected. No GitHub content was changed.");
    }
    setBusy(false);
  }

  async function candidateAction(action: "candidate" | "sync") {
    setBusy(true);
    setError(null);
    setNotice(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/${action}`, {
      method: "POST",
      headers: action === "candidate" ? { "content-type": "application/json" } : undefined,
      body: action === "candidate" ? JSON.stringify({ name: sessionTitle, description: sessionObjective ?? "" }) : undefined,
    });
    const body = await readResponse<{ repository?: RepositoryConnection; candidate?: RepositoryCandidate; error?: string }>(response);
    if (!response.ok || !body.repository || !body.candidate) {
      setError(body.error ?? "Unable to update the repository candidate");
    } else {
      setRepository(body.repository);
      setCandidate(body.candidate);
      onStateChange?.({ repository: body.repository, candidate: body.candidate });
      setNotice(action === "candidate" ? "Candidate branch ready." : "Repository state synchronized with GitHub.");
    }
    setBusy(false);
  }

  async function verifyRunner() {
    setBusy(true);
    setError(null);
    setLogs(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/preflight`, { method: "POST" });
    const body = await readResponse<{ preflight?: RepositoryPreflight; error?: string }>(response);
    if (!response.ok || !body.preflight) setError(body.error ?? "Unable to start repository preflight");
    else setPreflight(body.preflight);
    setBusy(false);
  }

  async function openLogs() {
    if (!preflight) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/preflight/${preflight.id}/logs`, { cache: "no-store" });
    const text = await response.text();
    if (!response.ok) setError("Unable to load command output");
    else setLogs(text);
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
          <p>No repository is connected yet. Select one already authorized in Account Settings.</p>
          {role === "owner" ? (
            <>
              <p className="form-note">If none appear, add or restore GitHub access under <a href={`${BASE_PATH}/home/settings?section=connections`}>Account Settings</a>.</p>
              <button className="button" data-variant="primary" onClick={edit} disabled={busy}>Select repository</button>
            </>
          ) : (
            <p className="repository-checks">Only session owner can select repository.</p>
          )}
        </>
      )}
      {repository && !editing && (
        <>
          <div className="repository-summary">
            <strong>{repository.repositoryFullName}</strong>
            <span>{repository.repositoryPrivate ? "Private" : "Public"} · base <code>{repository.baseBranch}</code></span>
            <span data-status={repository.status}>{connectionStatusLabel[repository.status]}</span>
          </div>
          {candidate && (
            <div className="repository-checks">
              <span>Active candidate</span>
              <p><strong>{candidate.name}</strong></p>
              {candidate.description && <p>{candidate.description}</p>}
              <p><code>{candidate.branchName}</code></p>
              <p>Candidate <code>{candidate.candidateSha?.slice(0, 8) ?? "creating"}</code> · base <code>{(candidate.remoteBaseSha ?? candidate.baseSha).slice(0, 8)}</code></p>
              {candidate.behindBase && <p className="form-note">Candidate is behind the current base branch.</p>}
              {repository.status === "externally_modified" && <p className="form-note">The candidate branch was modified outside openfloor.</p>}
            </div>
          )}
          <div className="repository-checks">
            <span>Check commands</span>
            {repository.checkCommands.length > 0
              ? <ol>{repository.checkCommands.map((item) => <li key={item.id}><code>{item.command}</code></li>)}</ol>
              : <><p>Not configured</p><p className="form-note">Optional. Without them, agent changes are not verified automatically before they&apos;re marked ready.</p></>}
          </div>
          {preflight && (
            <div className="repository-checks" aria-label="Runner verification">
              <span>Runner verification</span>
              <p><strong data-status={preflight.status}>{humanize(preflight.status)}</strong>{preflight.summary ? ` · ${preflight.summary}` : ""}</p>
              <ol>{preflight.checks.map((check) => (
                <li key={check.id}><code>{check.command}</code> — <span data-status={check.status}>{humanize(check.status)}</span>{check.exitCode == null ? "" : ` (exit ${check.exitCode})`}</li>
              ))}</ol>
              {preflight.checks.some((check) => check.hasLog) && <button className="button" onClick={() => void openLogs()} disabled={busy}>Open command output</button>}
              {logs != null && <pre className="repository-log-output">{logs}</pre>}
            </div>
          )}
          {role === "owner" && (
            <div className="button-row">
              {repository.status !== "disconnected" && repository.status !== "revoked" && repository.status !== "inaccessible" ? (
                <>
                  <button className="button" onClick={edit} disabled={busy}>Configure</button>
                  {!candidate && repository.status === "connected" && <button className="button" data-variant="primary" onClick={() => void candidateAction("candidate")} disabled={busy}>Retry candidate setup</button>}
                  {candidate && <button className="button" data-variant="primary" onClick={() => void candidateAction("sync")} disabled={busy}>Sync repository</button>}
                  {preflightEnabled && candidate && repository.status === "ready" && (
                    <button className="button" onClick={() => void verifyRunner()} disabled={busy || repository.checkCommands.length === 0 || Boolean(preflight && ["provisioning", "running"].includes(preflight.status))}>Verify runner</button>
                  )}
                  <button className="button danger-button" onClick={disconnect} disabled={busy}>Disconnect</button>
                </>
              ) : <button className="button" data-variant="primary" onClick={edit} disabled={busy}>Select account repository</button>}
            </div>
          )}
        </>
      )}
      {editing && role === "owner" && (
        <div className="repository-form">
          <div className="repository-field">
            <span>Repository</span>
            <SelectMenu
              label="Connected repository"
              value={repositoryId}
              onChange={(next) => void chooseRepository(next)}
              disabled={busy}
              options={repositories.map((item) => ({ value: item.id, label: item.fullName }))}
            />
          </div>
          <div className="repository-field">
            <span>Base branch</span>
            <SelectMenu
              label="Repository base branch"
              value={baseBranch}
              onChange={setBaseBranch}
              disabled={busy || branches.length === 0}
              options={branches.map((branch) => ({ value: branch, label: branch }))}
            />
          </div>
          <label>
            <span>Required check commands</span>
            <textarea aria-label="Required check commands" value={commands} onChange={(event) => setCommands(event.target.value)} rows={4} />
            <small>Optional. One command per line, e.g. <code>npm test</code> — each runs against the agent&apos;s changes and must pass before a run is marked ready. Leave this empty if you don&apos;t want automatic verification; agents can still run without it.</small>
          </label>
          <div className="button-row">
            <button className="button" data-variant="primary" onClick={save} disabled={busy || !selectedRepository || !baseBranch}>Save repository</button>
            {!beginSetup && repository?.status !== "disconnected" && <button className="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>}
          </div>
        </div>
      )}
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

"use client";

import { useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type {
  RepositoryCandidate,
  RepositoryConnection,
  RepositoryConnectionStatus,
  SessionRole,
} from "@/lib/session-types";

const connectionStatusLabel: Record<RepositoryConnectionStatus, string> = {
  connected: "Connected",
  ready: "Ready",
  revoked: "Access revoked",
  inaccessible: "Inaccessible",
  externally_modified: "Modified outside openfloor",
  disconnected: "Disconnected",
};

// Statuses where the repository connection itself needs attention in Account
// Settings — nothing this card can fix by talking to the candidate endpoint.
const NEEDS_RECONNECT: ReadonlySet<RepositoryConnectionStatus> = new Set(["revoked", "inaccessible", "disconnected"]);

async function readResponse<T extends { error?: string }>(response: Response): Promise<Partial<T>> {
  const text = await response.text();
  if (!text) return { error: `Something went wrong (${response.status}). Try again.` } as Partial<T>;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: `Something went wrong (${response.status}). Try again.` } as Partial<T>;
  }
}

// The repository itself is chosen once, on the Home create-session form —
// createSessionWithRepository provisions both the connection and a reserved
// candidate synchronously, before this card ever renders. So this card no
// longer offers repository selection, disconnect, or repository-level sync;
// it shows what was chosen, lets the owner rename the still-untouched
// candidate branch, and offers the one recovery path candidate provisioning
// can actually fail into (retry creating the candidate).
export function RepositoryCard({
  sessionId,
  sessionTitle,
  sessionObjective,
  role,
  initialRepository,
  initialCandidate,
  onStateChange,
}: {
  sessionId: string;
  sessionTitle: string;
  sessionObjective: string | null;
  role: SessionRole;
  initialRepository: RepositoryConnection | null;
  initialCandidate: RepositoryCandidate | null;
  onStateChange?: (state: { repository: RepositoryConnection | null; candidate: RepositoryCandidate | null }) => void;
}) {
  const [repository, setRepository] = useState(initialRepository);
  const [candidate, setCandidate] = useState(initialCandidate);
  const [syncedRepository, setSyncedRepository] = useState(initialRepository);
  const [syncedCandidate, setSyncedCandidate] = useState(initialCandidate);
  if (syncedRepository !== initialRepository || syncedCandidate !== initialCandidate) {
    setSyncedRepository(initialRepository);
    setSyncedCandidate(initialCandidate);
    setRepository(initialRepository);
    setCandidate(initialCandidate);
  }
  // The name draft resyncs whenever the candidate identity changes (a fresh
  // candidate after create/rename) but not on every render, so mid-edit
  // keystrokes survive incidental re-renders of the parent.
  const [nameDraft, setNameDraft] = useState(initialCandidate?.name ?? "");
  const [nameDraftCandidateId, setNameDraftCandidateId] = useState(initialCandidate?.id ?? null);
  if ((candidate?.id ?? null) !== nameDraftCandidateId) {
    setNameDraftCandidateId(candidate?.id ?? null);
    setNameDraft(candidate?.name ?? "");
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Renaming reuses the branch's own name-derived slug (lib/repository-refs.ts),
  // so it's only safe while nothing has been committed to the branch yet.
  const canRenameCandidate = Boolean(
    candidate && candidate.candidateSha === candidate.baseSha && candidate.integrationRunId == null,
  );
  const trimmedDraft = nameDraft.trim();

  async function createCandidate() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/candidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: sessionTitle, description: sessionObjective ?? "" }),
    });
    const body = await readResponse<{ repository?: RepositoryConnection; candidate?: RepositoryCandidate; error?: string }>(response);
    if (!response.ok || !body.repository || !body.candidate) {
      setError(body.error ?? "Unable to create the candidate branch");
    } else {
      setRepository(body.repository);
      setCandidate(body.candidate);
      onStateChange?.({ repository: body.repository, candidate: body.candidate });
      setNotice("Candidate branch ready.");
    }
    setBusy(false);
  }

  async function renameBranch() {
    if (!candidate || !trimmedDraft || trimmedDraft === candidate.name) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const deleteResponse = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/candidate`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deleteBranch: true }),
    });
    if (!deleteResponse.ok) {
      const body = await readResponse<{ error?: string }>(deleteResponse);
      setError(body.error ?? "Unable to rename the candidate branch");
      setBusy(false);
      return;
    }
    setCandidate(null);
    onStateChange?.({ repository, candidate: null });
    const createResponse = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/candidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmedDraft, description: candidate.description }),
    });
    const body = await readResponse<{ repository?: RepositoryConnection; candidate?: RepositoryCandidate; error?: string }>(createResponse);
    if (!createResponse.ok || !body.repository || !body.candidate) {
      // The old branch is already gone; fall back to the "create candidate"
      // state below rather than leaving the card stuck with nothing.
      setError(body.error ?? "The old branch was removed, but the renamed candidate could not be created. Retry below.");
      setBusy(false);
      return;
    }
    setRepository(body.repository);
    setCandidate(body.candidate);
    onStateChange?.({ repository: body.repository, candidate: body.candidate });
    setNotice("Candidate branch renamed.");
    setBusy(false);
  }

  return (
    <section className="action-card repository-card" aria-label="GitHub repository">
      <p className="eyebrow">Repository</p>
      <h2>GitHub connection</h2>
      {!repository ? (
        <p>No repository is connected. <a href={`${BASE_PATH}/home/settings?section=connections`}>Check GitHub access in Account Settings</a>.</p>
      ) : NEEDS_RECONNECT.has(repository.status) ? (
        <>
          <div className="repository-summary">
            <strong>{repository.repositoryFullName}</strong>
            <span data-status={repository.status}>{connectionStatusLabel[repository.status]}</span>
          </div>
          {role === "owner" ? (
            <p className="form-note">Reconnect from an active GitHub installation in <a href={`${BASE_PATH}/home/settings?section=connections`}>Account Settings</a>.</p>
          ) : (
            <p className="repository-checks">Only the session owner can manage GitHub access.</p>
          )}
        </>
      ) : (
        <>
          <div className="repository-summary">
            <strong>{repository.repositoryFullName}</strong>
            <span>{repository.repositoryPrivate ? "Private" : "Public"} · base <code>{repository.baseBranch}</code></span>
            {repository.status === "externally_modified" && <span data-status={repository.status}>{connectionStatusLabel[repository.status]}</span>}
          </div>
          {candidate ? (
            <div className="repository-checks">
              <span>Candidate branch</span>
              {role === "owner" ? (
                <>
                  <div className="button-row">
                    <label className="field">
                      <span className="label">Name</span>
                      <input
                        value={nameDraft}
                        onChange={(event) => setNameDraft(event.target.value)}
                        maxLength={100}
                        disabled={busy || !canRenameCandidate}
                      />
                    </label>
                    {canRenameCandidate && (
                      <button className="button" onClick={renameBranch} disabled={busy || !trimmedDraft || trimmedDraft === candidate.name}>
                        Rename branch
                      </button>
                    )}
                  </div>
                  {!canRenameCandidate && <p className="form-note">The branch name is fixed once work has started on it.</p>}
                </>
              ) : (
                <p><strong>{candidate.name}</strong></p>
              )}
              <p><code>{candidate.branchName}</code></p>
            </div>
          ) : repository.status === "connected" && role === "owner" ? (
            <div className="button-row">
              <button className="button" data-variant="primary" onClick={createCandidate} disabled={busy}>Create candidate branch</button>
            </div>
          ) : null}
        </>
      )}
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { MergeConflictCase } from "@/lib/floor-types";
import type { ConflictHunk } from "@/lib/conflict-hunks";
import type { ConflictManifest } from "@/lib/conflict-workspace";
import type { ConflictMutation, ManualConflictSelection } from "@/lib/conflict-resolution";

type FileDetail = {
  path: string; fingerprint: string; kind: string; wholeFileOnly: boolean; ours: string | null; theirs: string | null;
  oursDeleted: boolean; theirsDeleted: boolean; hunks: ConflictHunk[]; totalHunks: number; nextAfter: number | null; result?: string;
};
type Snapshot = { id: string; revision: number; files: ConflictManifest["files"]; detail: FileDetail | null; canPropose: boolean };
const key = (path: string, index: number) => JSON.stringify([path, index]);

export function ConflictResolverBody({ sessionId, conflict, busy, onExit, onMutation }: {
  sessionId: string; conflict: MergeConflictCase; busy: boolean; onExit: () => void; onMutation: ConflictMutation;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [choicesSnapshot, setChoicesSnapshot] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, ManualConflictSelection>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const endpoint = `${BASE_PATH}/api/sessions/${sessionId}/conflicts/${encodeURIComponent(conflict.id)}/snapshot`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json() as { snapshot?: Snapshot; error?: string };
      if (!response.ok || !body.snapshot) throw new Error(body.error ?? "File versions could not be loaded.");
      if (!controller.signal.aborted) { setSnapshot(body.snapshot); setError(null); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "File versions could not be loaded."); });
    return () => controller.abort();
  }, [endpoint, reload]);
  useEffect(() => {
    if (!snapshot) return;
    const controller = new AbortController();
    void fetch(`${endpoint}?file=${fileIndex}&after=${page}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const body = await response.json() as { snapshot?: Snapshot; error?: string };
      if (!response.ok || !body.snapshot) throw new Error(body.error ?? "File could not be loaded.");
      if (body.snapshot.id !== snapshot.id) throw new Error("File versions changed. Your draft remains below. Reload versions before deciding again.");
      if (!controller.signal.aborted) { setDetail(body.snapshot.detail); setError(null); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "File could not be loaded."); });
    return () => controller.abort();
  }, [endpoint, snapshot, fileIndex, page]);
  const entry = snapshot?.files[fileIndex];
  const activeDetail = detail?.path === entry?.path ? detail : null;
  const stale = Boolean(snapshot && (snapshot.id !== conflict.resolution?.snapshotId || Object.keys(choices).length > 0 && choicesSnapshot !== snapshot.id));
  const available = !busy && !submitting && !loading && !stale && snapshot?.canPropose && !conflict.currentResolverRunId && conflict.status !== "resolved";
  function choose(path: string, hunkIndex: number, choice: ManualConflictSelection["choice"], content?: string) {
    setChoicesSnapshot(snapshot?.id ?? null);
    setChoices((current) => {
      const next = { ...current };
      // Complete-file and section choices are mutually exclusive.
      for (const [id, selection] of Object.entries(next)) if (selection.path === path && (hunkIndex === -1 || selection.hunkIndex === -1)) delete next[id];
      next[key(path, hunkIndex)] = { path, hunkIndex, choice, ...(content !== undefined ? { content } : {}) };
      return next;
    });
  }
  function decided(file: ConflictManifest["files"][number]) {
    return Boolean(choices[key(file.path, -1)]) || !file.wholeFileOnly && file.hunkCount > 0 && Array.from({ length: file.hunkCount }, (_, index) => choices[key(file.path, index)]).every(Boolean);
  }
  async function editFullResult() {
    if (!snapshot || !entry) return;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${endpoint}?file=${fileIndex}&format=text`, { cache: "no-store" });
      const body = await response.json() as { snapshot?: Snapshot; error?: string };
      if (!response.ok || body.snapshot?.id !== snapshot.id || typeof body.snapshot.detail?.result !== "string") throw new Error(body.error ?? "Full file changed or cannot be edited. Refresh versions.");
      choose(entry.path, -1, "edited", body.snapshot.detail.result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Full file could not be loaded."); }
    finally { setLoading(false); }
  }
  async function submit() {
    if (!snapshot || !available) return;
    setSubmitting(true); setError(null);
    try {
      const result = await onMutation(conflict.id, "selections", { revision: conflict.resolution!.revision, snapshotId: snapshot.id, selections: Object.values(choices) });
      if (result.ok) onExit(); else setError(result.error ?? "Could not save this proposal. Your draft is preserved.");
    } finally { setSubmitting(false); }
  }
  const whole = entry ? choices[key(entry.path, -1)] : undefined;
  return <section className="conflict-center-detail" aria-label="Manual resolution">
    <h3>Choose the exact result</h3><p>Candidate contains the team’s integrated work. Incoming contains this prompt’s changes. Complete-file choices replace that entire file; section choices preserve untouched content. Submission proposes this exact result for agreement.</p>
    {stale && <p role="alert">Candidate changed. Draft preserved, submission disabled. Reload versions and review again.</p>}
    <div className="conflict-resolver-body">
      <nav className="conflict-file-list" aria-label="Affected files"><ul>{snapshot?.files.map((file, index) => <li key={file.path}><button className="conflict-file-item" type="button" aria-current={fileIndex === index ? "true" : undefined} onClick={() => { setFileIndex(index); setPage(0); }}><code>{file.path}</code><span>{decided(file) ? "Chosen" : "Needs choice"}</span></button></li>)}</ul></nav>
      <div className="conflict-file-detail">
        {entry && <><h4>{entry.path}</h4><div className="conflict-case-actions"><button className="button" disabled={!available} aria-pressed={whole?.choice === "ours"} onClick={() => choose(entry.path, -1, "ours")}>{activeDetail?.oursDeleted ? "Delete file (candidate)" : "Use complete candidate file"}</button><button className="button" disabled={!available} aria-pressed={whole?.choice === "theirs"} onClick={() => choose(entry.path, -1, "theirs")}>{activeDetail?.theirsDeleted ? "Delete file (incoming)" : "Use complete incoming file"}</button>{entry.canEdit && <button className="button" disabled={!available} onClick={() => void editFullResult()}>Edit complete result</button>}</div>
          {whole?.choice === "edited" ? <label>Complete result for {entry.path}<textarea className="conflict-full-editor" spellCheck={false} value={whole.content ?? ""} onChange={(event) => choose(entry.path, -1, "edited", event.target.value)} /><small>Entire file loaded. Remove all conflict markers before submitting.</small></label> : <>
            {whole && <p role="status">Entire {whole.choice === "ours" ? "candidate" : "incoming"} version selected.</p>}
            <div className="conflict-version-grid">{([['Candidate preview', activeDetail?.ours], ['Incoming preview', activeDetail?.theirs]] as const).map(([label, text]) => <div key={label}><h4>{label}</h4><pre className="conflict-result-preview">{text ?? "Binary, oversized, or deleted. The complete Git blob is preserved when selected."}</pre><small>Display preview only; complete-file choices use the original blob.</small></div>)}</div>
            {activeDetail?.hunks.map((hunk) => {
              const selection = choices[key(entry.path, hunk.index)]?.choice;
              const preview = selection === "ours" ? hunk.oursLines : selection === "theirs" ? hunk.theirsLines : selection === "both" ? [...hunk.oursLines, ...hunk.theirsLines] : null;
              return <fieldset key={hunk.index} disabled={!available}><legend>Section {hunk.index + 1}</legend><div className="conflict-version-grid"><pre className="conflict-result-preview" aria-label={`Candidate section ${hunk.index + 1}`}>{hunk.oursLines.join("\n")}</pre><pre className="conflict-result-preview" aria-label={`Incoming section ${hunk.index + 1}`}>{hunk.theirsLines.join("\n")}</pre></div>{([['ours', 'Candidate section'], ['theirs', 'Incoming section'], ['both', 'Concatenate candidate then incoming']] as const).map(([value, label]) => <label key={value}><input type="radio" name={key(entry.path, hunk.index)} checked={selection === value} onChange={() => choose(entry.path, hunk.index, value)} />{label}</label>)}{preview && <><strong>Result preview</strong><pre className="conflict-result-preview">{preview.join("\n")}</pre></>}</fieldset>;
            })}
            {activeDetail && activeDetail.totalHunks > 20 && <nav aria-label="Conflict sections"><button className="button" disabled={page === 0} onClick={() => setPage(Math.max(0, page - 20))}>Previous sections</button><button className="button" disabled={activeDetail.nextAfter === null} onClick={() => setPage(activeDetail.nextAfter!)}>Next sections</button></nav>}
          </>}
        </>}
        {!snapshot && !error && <p role="status">Loading exact file versions…</p>}
      </div>
    </div>
    {error && <p className="objective-error" role="alert">{error}</p>}
    <div className="conflict-case-actions"><button className="button" onClick={onExit}>Back</button><button className="button" onClick={() => { void onMutation(conflict.id, "reload"); setReload((value) => value + 1); }}>Retry loading</button><button className="button" disabled={busy || submitting} onClick={() => { setChoices({}); setPage(0); setFileIndex(0); setDetail(null); void onMutation(conflict.id, "reload"); setReload((value) => value + 1); }}>Discard draft and reload versions</button><button className="button" data-variant="primary" disabled={!available || !snapshot?.files.length || !snapshot.files.every(decided)} onClick={() => void submit()}>{submitting ? "Saving proposal…" : "Propose exact result"}</button></div>
  </section>;
}

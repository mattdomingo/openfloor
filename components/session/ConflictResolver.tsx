"use client";

import { useEffect, useMemo, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { ConflictChoice, ConflictFileSnapshot, ConflictHunk, ConflictSnapshot } from "@/lib/floor-types";
import { Icon, SegmentedControl } from "./primitives";

type LoadState = { key: string; snapshot: ConflictSnapshot | null; error: string | null };

function hunkKey(path: string, hunkIndex: number): string {
  return JSON.stringify([path, hunkIndex]);
}

// Every (path, hunkIndex) a real decision is needed for — unparseable files
// contribute none (there is nothing to show a human to decide on), which is
// exactly why they also block submission below rather than silently letting
// their markers pass through unresolved.
function requiredKeys(files: ConflictFileSnapshot[]): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    if (file.unparseable) continue;
    for (const hunk of file.hunks) keys.add(hunkKey(file.path, hunk.index));
  }
  return keys;
}

// The per-hunk manual resolver, rendered without its own dialog chrome so the
// conflict center can embed it as the guided flow's final step. onExit leaves
// the editor (back to the case overview); onSubmitted fires after a successful
// apply so the host decides where to go next.
export function ConflictResolverBody({ sessionId, caseId, busy, onExit, onSubmitted, onSubmit }: {
  sessionId: string;
  caseId: string;
  busy: boolean;
  onExit: () => void;
  onSubmitted: () => void;
  onSubmit: (caseId: string, snapshotRunId: string, selections: Array<{ path: string; hunkIndex: number; choice: ConflictChoice }>) => Promise<boolean>;
}) {
  const [result, setResult] = useState<LoadState | null>(null);
  const [selections, setSelections] = useState<Map<string, ConflictChoice>>(new Map());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${BASE_PATH}/api/sessions/${sessionId}/conflicts/${encodeURIComponent(caseId)}/snapshot`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { snapshot?: ConflictSnapshot; error?: string };
        if (!response.ok || !body.snapshot) throw new Error(body.error ?? "This conflict's snapshot could not be loaded");
        return body.snapshot;
      })
      .then((snapshot) => {
        if (cancelled) return;
        setResult({ key: caseId, snapshot, error: null });
        setSelections(new Map(snapshot.existingSelections.map((selection) => [hunkKey(selection.path, selection.hunkIndex), selection.choice])));
        setSelectedPath(snapshot.files.find((file) => !file.unparseable && file.hunks.length > 0)?.path ?? snapshot.files[0]?.path ?? null);
      })
      .catch((loadError) => { if (!cancelled) setResult({ key: caseId, snapshot: null, error: loadError instanceof Error ? loadError.message : "This conflict's snapshot could not be loaded" }); });
    return () => { cancelled = true; };
  }, [sessionId, caseId]);

  const snapshot = result?.key === caseId ? result.snapshot : null;
  const loadError = result?.key === caseId ? result.error : null;
  const loading = result?.key !== caseId;

  const required = useMemo(() => requiredKeys(snapshot?.files ?? []), [snapshot]);
  const decidedCount = useMemo(() => [...required].filter((key) => selections.has(key)).length, [required, selections]);
  const blockedByUnparseable = snapshot?.files.some((file) => file.unparseable) ?? false;
  const blockedByOmitted = (snapshot?.omittedPaths.length ?? 0) > 0;
  const canSubmit = Boolean(snapshot) && required.size > 0 && decidedCount === required.size && !blockedByUnparseable && !blockedByOmitted;

  function setHunkChoice(path: string, hunkIndex: number, choice: ConflictChoice) {
    setSelections((current) => new Map(current).set(hunkKey(path, hunkIndex), choice));
  }

  function applyToWholeFile(file: ConflictFileSnapshot, choice: ConflictChoice) {
    setSelections((current) => {
      const next = new Map(current);
      for (const hunk of file.hunks) next.set(hunkKey(file.path, hunk.index), choice);
      return next;
    });
  }

  async function submit() {
    if (!snapshot || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    const payload = [...required].map((key) => {
      const [path, hunkIndex] = JSON.parse(key) as [string, number];
      return { path, hunkIndex, choice: selections.get(key)! };
    });
    const ok = await onSubmit(caseId, snapshot.snapshotRunId, payload);
    setSubmitting(false);
    if (ok) onSubmitted();
    else setSubmitError("This conflict snapshot is out of date — reload and try again.");
  }

  const activeFile = snapshot?.files.find((file) => file.path === selectedPath) ?? null;

  return <>
    <p className="conflict-center-step">Choose ours, theirs, or both for every conflicting section. Choices are applied exactly, then checked and integrated. No AI rewrites your selection.</p>
    <div className="conflict-resolver-body">
      {loading ? <p className="review-empty">Loading conflicting sections…</p>
        : loadError ? <p className="review-empty" role="alert">{loadError}</p>
        : snapshot && <>
          <nav className="conflict-file-list" aria-label="Conflicted files">
            <ul>
              {snapshot.files.map((file) => {
                const fileRequired = file.unparseable ? [] : file.hunks.map((hunk) => hunkKey(file.path, hunk.index));
                const fileDecided = fileRequired.filter((key) => selections.has(key)).length;
                return <li key={file.path}>
                  <button type="button" className="conflict-file-item" data-selected={file.path === selectedPath ? "true" : "false"} onClick={() => setSelectedPath(file.path)}>
                    <Icon name="file" size={12} />
                    <code>{file.path}</code>
                    {file.unparseable
                      ? <span className="queue-chip" data-kind="status" data-status="failed">Can&rsquo;t parse</span>
                      : <span className="queue-chip" data-kind="status" data-status={fileDecided === fileRequired.length ? "ready" : "pending"}>{fileDecided}/{fileRequired.length}</span>}
                  </button>
                </li>;
              })}
              {snapshot.omittedPaths.map((path) => <li key={path}><span className="conflict-file-item" data-selected="false"><Icon name="file" size={12} /><code>{path}</code><span className="queue-chip" data-kind="status" data-status="failed">Too large</span></span></li>)}
            </ul>
          </nav>
          <div className="conflict-file-detail">
            {activeFile && <ConflictFileEditor file={activeFile} selections={selections} onHunkChoice={setHunkChoice} onWholeFile={applyToWholeFile} />}
            {blockedByUnparseable && <p className="conflict-markers-hint"><Icon name="alert" size={12} />One or more files couldn&rsquo;t be parsed for manual editing — resolve automatically instead, or ask the resolver to retry.</p>}
            {blockedByOmitted && <p className="conflict-markers-hint"><Icon name="alert" size={12} />Some conflicted files were too large to load here — resolve automatically instead.</p>}
          </div>
        </>}
    </div>
    <div className="dialog-foot">
      {snapshot && required.size > 0 && <span className="conflict-progress">{decidedCount}/{required.size} sections decided</span>}
      {submitError && <p className="objective-error">{submitError}</p>}
      <button type="button" className="button" data-variant="quiet" onClick={onExit} disabled={busy || submitting}>Back</button>
      <button type="button" className="button" data-variant="primary" disabled={!canSubmit || busy || submitting} onClick={() => void submit()}>{submitting ? "Applying…" : "Apply resolution"}</button>
    </div>
  </>;
}

function ConflictFileEditor({ file, selections, onHunkChoice, onWholeFile }: {
  file: ConflictFileSnapshot;
  selections: Map<string, ConflictChoice>;
  onHunkChoice: (path: string, hunkIndex: number, choice: ConflictChoice) => void;
  onWholeFile: (file: ConflictFileSnapshot, choice: ConflictChoice) => void;
}) {
  if (file.unparseable) return <p className="review-empty">This file&rsquo;s conflict markers could not be parsed — it isn&rsquo;t editable here.</p>;
  const isWholeFileChoice = file.kind !== "content";
  return <div className="conflict-file-editor">
    {file.kind === "content" && file.hunks.length > 1 && (
      <div className="conflict-file-bulk">
        <span>Apply to every section in this file</span>
        <SegmentedControl label={`Bulk choice for ${file.path}`} value="" onChange={(value) => onWholeFile(file, value as ConflictChoice)} options={[
          { value: "ours", label: "Ours" }, { value: "theirs", label: "Theirs" }, { value: "both", label: "Both" },
        ]} />
      </div>
    )}
    {file.hunks.map((hunk, index) => (
      <ConflictHunkEditor
        key={hunk.index}
        hunk={hunk}
        index={index}
        total={file.hunks.length}
        wholeFile={isWholeFileChoice}
        choice={selections.get(hunkKey(file.path, hunk.index)) ?? null}
        onChoice={(choice) => onHunkChoice(file.path, hunk.index, choice)}
      />
    ))}
  </div>;
}

function ConflictHunkEditor({ hunk, index, total, wholeFile, choice, onChoice }: {
  hunk: ConflictHunk;
  index: number;
  total: number;
  wholeFile: boolean;
  choice: ConflictChoice | null;
  onChoice: (choice: ConflictChoice) => void;
}) {
  const diverges = new Set(hunk.oursLines);
  const theirsDiverges = new Set(hunk.theirsLines);
  return <section className="conflict-hunk" data-decided={choice ? "true" : "false"}>
    <div className="conflict-hunk-head">
      <strong>{wholeFile ? "Whole file" : `Section ${index + 1} of ${total}`}</strong>
      <SegmentedControl label={wholeFile ? "Choice" : `Choice for section ${index + 1}`} value={choice ?? ""} onChange={(value) => onChoice(value as ConflictChoice)} options={
        wholeFile
          ? [{ value: "ours", label: hunk.oursLabel || "Ours" }, { value: "theirs", label: hunk.theirsLabel || "Theirs" }]
          : [{ value: "ours", label: "Ours" }, { value: "theirs", label: "Theirs" }, { value: "both", label: "Both" }]
      } />
    </div>
    <div className="conflict-panes">
      <section className="conflict-pane" data-side="ours" data-selected={choice === "ours" || choice === "both" ? "true" : undefined}>
        <div className="conflict-pane-head"><strong>{hunk.oursLabel || "Ours"}</strong></div>
        <pre className="review-code">{hunk.oursLines.length === 0 ? <span className="review-line"><i> </i><code>(no content)</code></span> : hunk.oursLines.map((text, lineIndex) => <span key={lineIndex} className="review-line" data-diverges={!theirsDiverges.has(text) ? "true" : undefined}><i>{choice === "ours" || choice === "both" ? "+" : " "}</i><code>{text}</code></span>)}</pre>
      </section>
      <section className="conflict-pane" data-side="theirs" data-selected={choice === "theirs" || choice === "both" ? "true" : undefined}>
        <div className="conflict-pane-head"><strong>{hunk.theirsLabel || "Theirs"}</strong></div>
        <pre className="review-code">{hunk.theirsLines.length === 0 ? <span className="review-line"><i> </i><code>(no content)</code></span> : hunk.theirsLines.map((text, lineIndex) => <span key={lineIndex} className="review-line" data-diverges={!diverges.has(text) ? "true" : undefined}><i>{choice === "theirs" || choice === "both" ? "+" : " "}</i><code>{text}</code></span>)}</pre>
      </section>
    </div>
  </section>;
}

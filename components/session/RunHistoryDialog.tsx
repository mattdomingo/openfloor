"use client";

import { useEffect, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { AgentRun } from "@/lib/floor-types";
import { ActivityTimeline, ArtifactToggle } from "./AgentCard";
import { runStatusToken } from "./data";
import { Markdown } from "./Markdown";
import { Icon, Spinner, useDialogDismiss } from "./primitives";
import type { RunActivitySource } from "./useRunActivity";

type Page = { runs: AgentRun[]; nextCursor: string | null };

async function readPage(sessionId: string, before: string | null, signal?: AbortSignal): Promise<Page> {
  const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/runs${before ? `?before=${encodeURIComponent(before)}` : ""}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Run history could not be loaded.");
  return response.json() as Promise<Page>;
}

export function RunHistoryDialog({ sessionId, activity, onClose }: { sessionId: string; activity: RunActivitySource; onClose: () => void }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void readPage(sessionId, null, controller.signal).then((page) => {
      setRuns(page.runs); setNextCursor(page.nextCursor);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Run history could not be loaded.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId]);
  async function loadMore() {
    if (loading) return;
    setLoading(true); setError(null);
    try {
      const page = await readPage(sessionId, nextCursor);
      setRuns((current) => [...current, ...page.runs.filter((run) => !current.some((existing) => existing.id === run.id))]);
      setNextCursor(page.nextCursor);
    } catch { setError("Run history could not be loaded."); }
    finally { setLoading(false); }
  }
  const selected = runs.find((run) => run.id === selectedId);
  return <dialog className="dialog chat-history" {...dialogProps} aria-labelledby="run-history-title">
    <div className="dialog-head"><div className="dialog-title"><h2 id="run-history-title">Run history</h2><p>Retained runs, including inactive and removed agents.</p></div><button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button></div>
    <div className="dialog-body">
      {error && <p className="form-error" role="alert">{error} <button type="button" className="button" onClick={() => void loadMore()}>Retry</button></p>}
      {loading && <p role="status"><Spinner /> Loading runs…</p>}
      {!loading && !error && runs.length === 0 && <p>No runs yet.</p>}
      <ol className="chat-thread">{runs.map((run) => <li key={run.id}>
        <button type="button" className="button" aria-expanded={selectedId === run.id} onClick={() => setSelectedId(selectedId === run.id ? null : run.id)}>
          {run.agentName} · {run.agentKind === "answer" ? "Concierge" : run.agentKind === "worker" ? "Generated worker" : "Persistent agent"} · {runStatusToken(run)} · attempt {run.attempt} · <LocalDateTime timestamp={run.createdAt} />
        </button>
        {selected?.id === run.id && <div className="spotlight-execution">
          <p>{run.model}</p>
          {run.finalResponse && <Markdown>{run.finalResponse}</Markdown>}
          {run.summary && <p>{run.summary}</p>}
          {run.files.length > 0 && <ul>{run.files.map((file) => <li key={file.id}><code>{file.path}</code> · +{file.additions} −{file.deletions}{file.diffPreview && <pre className="agent-raw-log-output">{file.diffPreview}</pre>}</li>)}</ul>}
          <ActivityTimeline run={run} activity={activity} />
          <ArtifactToggle sessionId={sessionId} run={run} label="Open raw log" closeLabel="Hide raw log" emptyText="No retained log is available." />
        </div>}
      </li>)}</ol>
      {nextCursor && <button type="button" className="button" disabled={loading} onClick={() => void loadMore()}>Load older runs</button>}
    </div>
  </dialog>;
}

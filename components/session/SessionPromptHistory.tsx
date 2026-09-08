"use client";

import { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { SessionPromptHistoryDetail, SessionPromptHistoryPage } from "@/lib/floor-types";
import { LocalDateTime } from "@/components/LocalDateTime";
import { Markdown } from "./Markdown";
import { SelectMenu } from "./SelectMenu";

const EMPTY: SessionPromptHistoryPage = { items: [], nextCursor: null, engineers: [], agents: [] };
export function useSessionPromptHistory(sessionId: string, revision: number, enabled: boolean, engineerId: string | null, agentId: string | null) {
  const key = JSON.stringify([sessionId, revision, enabled, engineerId, agentId]);
  const [result, setResult] = useState<{ key: string; page: SessionPromptHistoryPage; error: string | null; requestKey: string } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [previousKey, setPreviousKey] = useState(key);
  if (key !== previousKey) { setPreviousKey(key); setCursor(null); }
  const requestKey = `${key}:${cursor}:${retry}`;
  const inFlightKey = useRef("");
  useEffect(() => {
    if (!enabled) return;
    inFlightKey.current = requestKey;
    let cancelled = false;
    const query = new URLSearchParams();
    if (cursor) query.set("before", cursor);
    if (engineerId) query.set("engineerId", engineerId);
    if (agentId) query.set("agentId", agentId);
    void fetch(`${BASE_PATH}/api/sessions/${sessionId}/review/prompts?${query}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Prompts could not be loaded.");
      const page = await response.json() as SessionPromptHistoryPage;
      if (!cancelled && inFlightKey.current === requestKey) setResult((current) => ({ key, requestKey, page: cursor && current?.key === key ? { ...page, items: [...new Map([...current.page.items, ...page.items].map((item) => [item.id, item])).values()] } : page, error: null }));
    }).catch((error: unknown) => { if (!cancelled) setResult((current) => ({ key, requestKey, page: current?.key === key ? current.page : EMPTY, error: error instanceof Error ? error.message : "Prompts could not be loaded." })); });
    return () => { cancelled = true; };
  }, [key, requestKey, cursor, enabled, sessionId, engineerId, agentId]);
  const page = result?.key === key ? result.page : EMPTY;
  return { ...page, selectedId: page.items.some((item) => item.id === selection) ? selection : page.items[0]?.id ?? null, select: setSelection, error: result?.key === key ? result.error : null, loading: enabled && result?.key !== key, busy: enabled && result?.requestKey !== requestKey, retry: () => setRetry((value) => value + 1), loadMore: () => { setCursor(page.nextCursor); setRetry((value) => value + 1); } };
}

export function SessionPromptRail({ history }: { history: ReturnType<typeof useSessionPromptHistory> }) {
  return <>
    {history.loading ? <p className="review-empty">Loading prompts…</p> : history.error ? <p className="review-empty" role="alert">{history.error}<button type="button" className="button" disabled={history.busy} onClick={history.retry}>Retry</button></p> : history.items.length === 0 ? <p className="review-empty">No session prompts match these filters.</p> :
      <ul className="review-prompt-list">{history.items.map((prompt) => <li key={prompt.id}><button type="button" className="review-prompt-item" data-selected={history.selectedId === prompt.id} onClick={() => history.select(prompt.id)}>
        <strong>{prompt.origin ? "System feedback" : prompt.authorName}</strong><span className="review-prompt-preview">{prompt.text}</span><small>{prompt.agentName ?? "Unassigned"} · {prompt.dismissedAt ? "Dismissed" : prompt.status}</small>
      </button></li>)}</ul>}
    {history.nextCursor && <div className="review-load-more"><button type="button" className="button" disabled={history.busy} onClick={history.loadMore}>{history.busy ? "Loading…" : "Load more"}</button></div>}
  </>;
}

export function SessionPromptDetail({ sessionId, promptId, revision }: { sessionId: string; promptId: string | null; revision: number }) {
  const [result, setResult] = useState<{ key: string; detail: SessionPromptHistoryDetail; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const key = `${sessionId}:${promptId}:${revision}`;
  const [previousKey, setPreviousKey] = useState(key);
  if (previousKey !== key) { setPreviousKey(key); setCursor(null); setError(null); setRunId(null); }
  useEffect(() => {
    if (!promptId) return;
    let cancelled = false;
    void fetch(`${BASE_PATH}/api/sessions/${sessionId}/review/prompts/${encodeURIComponent(promptId)}${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Prompt changes could not be loaded.");
      const detail = await response.json() as SessionPromptHistoryDetail;
      if (!cancelled) { setError(null); setResult((current) => ({ key, detail: cursor && current?.key === key ? { ...detail, runs: [...new Map([...current.detail.runs, ...detail.runs].map((run) => [run.id, run])).values()] } : detail })); }
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Prompt changes could not be loaded."); });
    return () => { cancelled = true; };
  }, [sessionId, promptId, revision, cursor, key, retry]);
  const detail = result?.key === key ? result.detail : null;
  const run = detail?.runs.find((item) => item.id === runId) ?? detail?.runs[0];
  return <section className="review-pane review-diff" aria-label="Prompt changes">
    <div className="review-pane-head"><h3>Prompt changes</h3></div>
    {!promptId ? <p className="review-empty">Select a prompt.</p> : error ? <p className="review-empty" role="alert">{error}<button type="button" className="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p> : !detail ? <p className="review-empty">Loading changes…</p> : <>
      <div className="review-summary"><strong>{detail.prompt.origin ? "System feedback" : detail.prompt.authorName}</strong><Markdown>{detail.prompt.text}</Markdown><p>{detail.prompt.agentName ?? "Unassigned"} · {detail.prompt.status} · <LocalDateTime timestamp={detail.prompt.createdAt} /></p></div>
      {detail.runs.length > 0 && <SelectMenu label="Run attempt" value={run?.id ?? ""} onChange={setRunId} options={detail.runs.map((item) => ({ value: item.id, label: `Attempt ${item.attempt} · ${item.agentName} · ${item.status}` }))} />}
      {run?.finalResponse && <Markdown className="review-summary">{run.finalResponse}</Markdown>}
      {run?.files.length ? run.files.map((file) => <section key={file.id}><div className="review-pane-head"><h3>{file.path}</h3></div>{file.diffPreview ? <pre className="review-code" aria-label={`Diff preview for ${file.path}`}>{file.diffPreview.split("\n").map((line, index) => <span className="review-line" data-type={line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context"} key={index}><code>{line}</code></span>)}</pre> : <p className="review-empty">No diff preview available.</p>}</section>) : <p className="review-empty">{run ? "This attempt has no recorded file changes." : "This prompt has not produced a run."}</p>}
      {detail.nextCursor && <button type="button" className="button" onClick={() => setCursor(detail.nextCursor)}>Earlier attempts</button>}
    </>}
  </section>;
}

"use client";

import { useEffect, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { AgentRunRollbackScope, ReviewRollbackImpact } from "@/lib/floor-types";
import { useDialogDismiss } from "./primitives";

export type RollbackIntent = { scope: AgentRunRollbackScope; subjectId: string };

export function RollbackImpactDialog({ sessionId, intent, busy, onClose, onConfirm }: {
  sessionId: string;
  intent: RollbackIntent;
  busy: boolean;
  onClose: () => void;
  onConfirm: (impact: ReviewRollbackImpact) => Promise<boolean>;
}) {
  const requestKey = `${intent.scope}:${intent.subjectId}`;
  const [result, setResult] = useState<{ key: string; impact: ReviewRollbackImpact | null; error: string | null } | null>(null);
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ scope: intent.scope, subjectId: intent.subjectId });
    void fetch(`${BASE_PATH}/api/sessions/${sessionId}/review/rollback-impact?${query}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as { impact?: ReviewRollbackImpact; error?: string };
        if (!response.ok || !result.impact) throw new Error(result.error ?? "Rollback impact could not be loaded");
        return result.impact;
      })
      .then((next) => { if (!cancelled) setResult({ key: requestKey, impact: next, error: null }); })
      .catch((loadError) => { if (!cancelled) setResult({ key: requestKey, impact: null, error: loadError instanceof Error ? loadError.message : "Rollback impact could not be loaded" }); });
    return () => { cancelled = true; };
  }, [intent.scope, intent.subjectId, requestKey, sessionId]);

  const impact = result?.key === requestKey ? result.impact : null;
  const error = result?.key === requestKey ? result.error : null;
  const loading = result?.key !== requestKey;

  const title = intent.scope === "prompt" ? "Remove these prompt changes?" : `Remove all changes from this ${intent.scope}?`;
  return <dialog className="dialog rollback-impact-dialog" {...dialogProps} aria-labelledby="rollback-impact-title">
    <div className="dialog-head"><div className="dialog-title"><h2 id="rollback-impact-title">{title}</h2><p>OpenFloor creates one inverse commit. Nothing publishes if the revert conflicts.</p></div></div>
    <div className="rollback-impact-body">
      {loading ? <p className="review-empty">Calculating exact impact…</p> : error ? <p className="review-empty" role="alert">{error}</p> : impact && <>
        <p><strong>{impact.subjectName}</strong> · {impact.targets.length} prompt group{impact.targets.length === 1 ? "" : "s"} · {new Set(impact.targets.flatMap((target) => target.files.map((file) => file.path))).size} file{new Set(impact.targets.flatMap((target) => target.files.map((file) => file.path))).size === 1 ? "" : "s"}</p>
        <ul className="rollback-impact-list">{impact.targets.map((target) => <li key={target.runId}><strong>{target.agentName}</strong><span>{target.prompts.map((prompt) => `${prompt.authorName}: ${prompt.text}`).join(" · ")}</span><small>{target.files.map((file) => file.path).join(", ")}</small></li>)}</ul>
        {impact.excluded.length > 0 && <div className="rollback-impact-excluded"><strong>Not removed</strong><p>{impact.excluded.length} merged group{impact.excluded.length === 1 ? " is" : "s are"} shared with another engineer and require explicit group rollback.</p></div>}
      </>}
    </div>
    <div className="dialog-foot"><button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button><button type="button" className="button danger-button" disabled={busy || !impact || loading || Boolean(error)} onClick={() => { if (impact) void onConfirm(impact).then((ok) => { if (ok) onClose(); }); }}>{busy ? "Starting…" : "Remove changes"}</button></div>
  </dialog>;
}

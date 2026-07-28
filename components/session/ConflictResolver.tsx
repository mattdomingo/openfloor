"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Conflict } from "./data";
import { Icon, SegmentedControl } from "./primitives";

type ResolverMode = "manual" | "ai";

const CONFLICT_MARKERS = ["<<<<<<<", "=======", ">>>>>>>"];

function markerText(conflict: Conflict): string {
  return [
    "<<<<<<< current",
    ...conflict.ours.lines,
    "=======",
    ...conflict.theirs.lines,
    ">>>>>>> incoming",
  ].join("\n");
}

export function ConflictResolver({
  conflict,
  onResolve,
  onClose,
}: {
  conflict: Conflict;
  onResolve: (conflictId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<ResolverMode>("manual");
  const [result, setResult] = useState(() => markerText(conflict));

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const hasMarkers = useMemo(() => CONFLICT_MARKERS.some((marker) => result.includes(marker)), [result]);

  function acceptCurrent() {
    setResult(conflict.ours.lines.join("\n"));
  }

  function acceptIncoming() {
    setResult(conflict.theirs.lines.join("\n"));
  }

  function acceptBoth() {
    setResult([...conflict.ours.lines, ...conflict.theirs.lines].join("\n"));
  }

  function markResolved() {
    onResolve(conflict.id);
  }

  function applySuggested() {
    onResolve(conflict.id);
  }

  return (
    <dialog className="dialog conflict-resolver" ref={dialogRef} onClose={onClose}>
      <div className="dialog-head">
        <div className="dialog-title">
          <h2>Merge conflict</h2>
          <p>
            <Icon name="file" size={12} /> {conflict.path}
          </p>
        </div>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>

      <div className="dialog-body">
        <SegmentedControl
          label="Resolution mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "manual", label: "Resolve manually" },
            { value: "ai", label: "Walk me through it" },
          ]}
        />

        {mode === "manual" ? (
          <div className="conflict-manual">
            <div className="conflict-panes">
              <section className="conflict-pane">
                <div className="conflict-pane-head">
                  <strong>Current change · {conflict.ours.agentName}</strong>
                  <button type="button" className="button" data-size="sm" onClick={acceptCurrent}>
                    Accept current
                  </button>
                </div>
                <pre className="review-code">
                  {conflict.ours.lines.map((text, index) => (
                    <span key={index} className="review-line" data-type="add">
                      <i>+</i>
                      <code>{text}</code>
                    </span>
                  ))}
                </pre>
              </section>

              <section className="conflict-pane">
                <div className="conflict-pane-head">
                  <strong>Incoming change · {conflict.theirs.agentName}</strong>
                  <button type="button" className="button" data-size="sm" onClick={acceptIncoming}>
                    Accept incoming
                  </button>
                </div>
                <pre className="review-code">
                  {conflict.theirs.lines.map((text, index) => (
                    <span key={index} className="review-line" data-type="add">
                      <i>+</i>
                      <code>{text}</code>
                    </span>
                  ))}
                </pre>
              </section>
            </div>

            <div className="conflict-actions">
              <button type="button" className="button" data-size="sm" onClick={acceptBoth}>
                Accept both
              </button>
            </div>

            <label className="field conflict-result">
              <span className="label">Resulting file</span>
              <textarea
                className="field-mono"
                rows={8}
                value={result}
                onChange={(event) => setResult(event.target.value)}
                spellCheck={false}
              />
            </label>
          </div>
        ) : (
          <div className="conflict-ai">
            <ol className="conflict-ai-steps">
              {conflict.aiSteps.map((step) => (
                <li key={step.title} className="conflict-ai-step">
                  <strong>{step.title}</strong>
                  <p>{step.detail}</p>
                </li>
              ))}
            </ol>
            <div className="conflict-pane">
              <div className="conflict-pane-head">
                <strong>Suggested resolution</strong>
              </div>
              <pre className="review-code">
                {conflict.resolutionLines.map((text, index) => (
                  <span key={index} className="review-line" data-type="add">
                    <i>+</i>
                    <code>{text}</code>
                  </span>
                ))}
              </pre>
            </div>
          </div>
        )}
      </div>

      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={onClose}>
          Cancel
        </button>
        {mode === "manual" ? (
          <button type="button" className="button" data-variant="primary" disabled={hasMarkers} onClick={markResolved}>
            Mark resolved
          </button>
        ) : (
          <button type="button" className="button" data-variant="primary" onClick={applySuggested}>
            Apply suggested resolution
          </button>
        )}
      </div>
    </dialog>
  );
}

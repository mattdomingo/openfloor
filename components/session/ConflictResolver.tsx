"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Agent, Conflict, ConflictSide } from "./data";
import { Icon, SegmentedControl } from "./primitives";

type ResolverMode = "manual" | "ai";
type AcceptChoice = "current" | "incoming" | "both";

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
  agents,
  onResolve,
  onClose,
}: {
  conflict: Conflict;
  agents: Agent[];
  onResolve: (conflictId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<ResolverMode>("manual");
  const [result, setResult] = useState(() => markerText(conflict));
  const [choice, setChoice] = useState<AcceptChoice | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const hasMarkers = useMemo(() => CONFLICT_MARKERS.some((marker) => result.includes(marker)), [result]);

  function agentColor(side: ConflictSide): string {
    return agents.find((agent) => agent.id === side.agentId)?.color ?? "var(--accent)";
  }

  function accept(kind: AcceptChoice) {
    if (kind === "current") setResult(conflict.ours.lines.join("\n"));
    else if (kind === "incoming") setResult(conflict.theirs.lines.join("\n"));
    else setResult([...conflict.ours.lines, ...conflict.theirs.lines].join("\n"));
    setChoice(kind);
  }

  function reset() {
    setResult(markerText(conflict));
    setChoice(null);
  }

  function markResolved() {
    onResolve(conflict.id);
  }

  function applySuggested() {
    setResult(conflict.resolutionLines.join("\n"));
    setChoice(null);
    setMode("manual");
  }

  function renderPane(side: ConflictSide, other: ConflictSide, label: string, kind: AcceptChoice) {
    const otherLines = new Set(other.lines);
    return (
      <section className="conflict-pane" data-side={kind} style={{ "--agent-color": agentColor(side) } as CSSProperties}>
        <div className="conflict-pane-head">
          <strong>
            <span className="conflict-agent-dot" aria-hidden="true" />
            {label} · {side.agentName}
          </strong>
          <button
            type="button"
            className="button"
            data-size="sm"
            data-selected={choice === kind ? "true" : "false"}
            onClick={() => accept(kind)}
          >
            Accept {kind}
          </button>
        </div>
        <pre className="review-code">
          {side.lines.map((text, index) => {
            const diverges = !otherLines.has(text);
            return (
              <span key={index} className="review-line" data-diverges={diverges ? "true" : undefined}>
                <i>{diverges ? "+" : " "}</i>
                <code>{text}</code>
              </span>
            );
          })}
        </pre>
      </section>
    );
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
              {renderPane(conflict.ours, conflict.theirs, "Current change", "current")}
              {renderPane(conflict.theirs, conflict.ours, "Incoming change", "incoming")}
            </div>

            <div className="conflict-actions">
              <button type="button" className="button" data-size="sm" data-variant="quiet" onClick={reset}>
                Reset
              </button>
              <button
                type="button"
                className="button"
                data-size="sm"
                data-selected={choice === "both" ? "true" : "false"}
                onClick={() => accept("both")}
              >
                Accept both
              </button>
            </div>

            <label className="field conflict-result">
              <span className="label">Resulting file</span>
              <textarea
                className="field-mono"
                rows={8}
                value={result}
                onChange={(event) => {
                  setResult(event.target.value);
                  setChoice(null);
                }}
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
        {mode === "manual" && hasMarkers && (
          <span className="conflict-markers-hint">
            <Icon name="alert" size={12} /> Conflict markers remain
          </span>
        )}
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

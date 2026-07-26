"use client";

import { useState } from "react";
import {
  CandidateChange,
  ReviewCheck,
  ReviewStatus,
  candidateBranch,
  candidateChanges,
  diffPreview,
  integrationWarnings,
  repoSummary,
  reviewChecks,
} from "./data";
import { Icon } from "./primitives";

const fileMarks: Record<CandidateChange["state"], string> = { modified: "M", attention: "!", pending: "…" };

function checkIcon(state: ReviewCheck["state"]) {
  if (state === "passed") return <Icon name="check" size={12} />;
  if (state === "failed") return <Icon name="alert" size={12} />;
  return <Icon name="clock" size={12} />;
}

const statusCopy: Record<ReviewStatus, string> = {
  awaiting: "Awaiting review",
  "changes-requested": "Changes requested",
  approved: "Approved · not merged",
};

export function ReviewScreen({
  conflictResolved,
  onNotice,
}: {
  conflictResolved: boolean;
  onNotice: (notice: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(candidateChanges[1]?.id ?? candidateChanges[0].id);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("awaiting");
  const selected = candidateChanges.find((change) => change.id === selectedId) ?? candidateChanges[0];
  const warnings = conflictResolved
    ? integrationWarnings.filter((warning) => warning.id !== "scope-overlap")
    : integrationWarnings;
  const passing = reviewChecks.filter((check) => check.state === "passed").length;

  return (
    <section className="review-screen" aria-label="Review candidate branch">
      <header className="review-hero">
        <div className="review-hero-copy">
          <span className="label">Candidate branch</span>
          <h2>
            <Icon name="branch" size={16} />
            {candidateBranch.name}
          </h2>
          <p>
            Review the integrated result of agent worktrees. Approving updates local review status only — nothing is
            merged or deployed.
          </p>
        </div>
        <div className="review-hero-facts">
          <div>
            <span className="label">Commit</span>
            <strong className="value">{candidateBranch.sha}</strong>
          </div>
          <div>
            <span className="label">Base</span>
            <strong className="value">{candidateBranch.base}</strong>
          </div>
          <div>
            <span className="label">Diff</span>
            <strong>
              <span className="add">+{repoSummary.additions}</span>{" "}
              <span className="del">−{repoSummary.deletions}</span>
            </strong>
          </div>
          <div>
            <span className="label">Review status</span>
            <strong data-status={reviewStatus}>{statusCopy[reviewStatus]}</strong>
          </div>
        </div>
        <div className="review-actions">
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={() => {
              setReviewStatus("changes-requested");
              onNotice("Changes requested on the candidate branch · local review only");
            }}
          >
            Request changes
          </button>
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => {
              setReviewStatus("approved");
              onNotice("Candidate approved · not merged or deployed");
            }}
          >
            Approve candidate
          </button>
        </div>
      </header>

      <div className="review-grid">
        <aside className="review-pane" aria-label="Changed files">
          <div className="review-pane-head">
            <h3>Files changed</h3>
            <span>{candidateChanges.length}</span>
          </div>
          <ul className="review-file-list">
            {candidateChanges.map((file) => (
              <li key={file.id}>
                <button
                  type="button"
                  className="review-file"
                  data-selected={selected.id === file.id ? "true" : "false"}
                  onClick={() => setSelectedId(file.id)}
                >
                  <span className="file-mark" data-state={file.state}>
                    {fileMarks[file.state]}
                  </span>
                  <span className="file-copy">
                    <strong>{file.path.split("/").pop()}</strong>
                    <span>
                      {file.path.split("/").slice(0, -1).join("/")} · {file.agent}
                    </span>
                  </span>
                  <span className="diff-stat">
                    <i className="add">+{file.add}</i>
                    <i className="del">−{file.del}</i>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="review-pane review-diff" aria-label="Change preview">
          <div className="review-pane-head">
            <h3>Change preview</h3>
            <span className="value">
              {selected.path} · {selected.agent}
            </span>
          </div>
          <p className="review-summary">{selected.summary}</p>
          <pre className="review-code" aria-label={`Diff preview for ${diffPreview.path}`}>
            {diffPreview.lines.map((line, index) => (
              <span key={`${index}-${line.text}`} className="review-line" data-type={line.type}>
                <i>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</i>
                <code>{line.text}</code>
              </span>
            ))}
          </pre>
        </section>

        <aside className="review-side">
          <section className="review-pane" aria-label="Integration warnings">
            <div className="review-pane-head">
              <h3>Integration</h3>
              <span>{warnings.length}</span>
            </div>
            {warnings.length === 0 ? (
              <p className="review-empty">No merge conflicts or integration warnings on the candidate.</p>
            ) : (
              <ul className="review-warning-list">
                {warnings.map((warning) => (
                  <li key={warning.id} data-severity={warning.severity}>
                    <strong>{warning.title}</strong>
                    <p>{warning.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="review-pane" aria-label="Checks">
            <div className="review-pane-head">
              <h3>Checks</h3>
              <span>
                {passing}/{reviewChecks.length}
              </span>
            </div>
            <ul className="review-check-list">
              {reviewChecks.map((check) => (
                <li key={check.id}>
                  <span className="check-mark" data-state={check.state}>
                    {checkIcon(check.state)}
                  </span>
                  <div>
                    <strong>{check.name}</strong>
                    <span>{check.detail}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </section>
  );
}

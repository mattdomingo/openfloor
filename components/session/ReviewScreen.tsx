"use client";

import { CSSProperties, useMemo, useState } from "react";
import {
  Agent,
  CandidateChange,
  Conflict,
  ReviewCheck,
  ReviewStatus,
  TeamChatMessage,
  agentDiffLines,
  agentReviewChanges,
  agentReviewChecks,
  agentReviewWarnings,
  candidateBranch,
  candidateChanges,
  conflicts,
  diffPreview,
  integrationWarnings,
  repoSummary,
  reviewChecks,
  statusLabel,
  statusTone,
} from "./data";
import { ConflictResolver } from "./ConflictResolver";
import { Icon, SegmentedControl } from "./primitives";
import { TeamChat } from "./TeamChat";

type ReviewViewMode = "candidate" | "agent";

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
  agents,
  conflictResolved,
  onNotice,
  onResolveConflict,
  teamChat,
  onSendTeamMessage,
}: {
  agents: Agent[];
  conflictResolved: boolean;
  onNotice: (notice: string) => void;
  onResolveConflict: () => void;
  teamChat: TeamChatMessage[];
  onSendTeamMessage: (text: string) => void;
}) {
  const [viewMode, setViewMode] = useState<ReviewViewMode>("candidate");
  const [viewedAgentId, setViewedAgentId] = useState(agents[0]?.id ?? "");
  const [selectedId, setSelectedId] = useState(candidateChanges[1]?.id ?? candidateChanges[0].id);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("awaiting");
  const [resolvedConflictIds, setResolvedConflictIds] = useState<Set<string>>(
    () => new Set(conflictResolved ? ["scope-overlap"] : []),
  );
  const [openConflictId, setOpenConflictId] = useState<string | null>(null);

  const viewedAgent = viewMode === "agent" ? agents.find((agent) => agent.id === viewedAgentId) ?? agents[0] : null;

  const changes = viewedAgent ? agentReviewChanges(viewedAgent) : candidateChanges;
  const selected = changes.find((change) => change.id === selectedId) ?? changes[0];
  const checks = viewedAgent ? agentReviewChecks(viewedAgent) : reviewChecks;
  const warnings = (viewedAgent ? agentReviewWarnings(viewedAgent) : integrationWarnings).filter(
    (warning) => !resolvedConflictIds.has(warning.id),
  );
  const passing = checks.filter((check) => check.state === "passed").length;
  const diffStat = useMemo(
    () => changes.reduce((totals, change) => ({ add: totals.add + change.add, del: totals.del + change.del }), { add: 0, del: 0 }),
    [changes],
  );
  const agentDiff = viewedAgent ? agentDiffLines(viewedAgent) : null;
  const showAgentDiff = Boolean(viewedAgent && agentDiff && selected?.path === agentDiff.path);
  const openConflict: Conflict | undefined = conflicts.find((entry) => entry.id === openConflictId);

  function selectViewMode(mode: ReviewViewMode) {
    setViewMode(mode);
    if (mode === "agent" && !viewedAgentId) setViewedAgentId(agents[0]?.id ?? "");
  }

  function selectAgent(agentId: string) {
    setViewedAgentId(agentId);
    const nextChanges = agentReviewChanges(agents.find((agent) => agent.id === agentId) ?? agents[0]);
    setSelectedId(nextChanges[0]?.id ?? selectedId);
  }

  function resolveConflict(conflictId: string) {
    if (conflictId === "scope-overlap") onResolveConflict();
    setResolvedConflictIds((current) => new Set(current).add(conflictId));
    setOpenConflictId(null);
    onNotice(`Conflict resolved on ${conflicts.find((entry) => entry.id === conflictId)?.path ?? "candidate branch"}`);
  }

  return (
    <section className="review-screen" aria-label="Review candidate branch">
      <header className="review-hero">
        <div className="review-branch-toggle">
          <SegmentedControl
            label="Branch view"
            value={viewMode}
            onChange={selectViewMode}
            options={[
              { value: "candidate", label: "Target branch" },
              { value: "agent", label: "Agent branch" },
            ]}
          />
          {viewMode === "agent" && (
            <div className="review-agent-chips" role="group" aria-label="Choose an agent branch">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="review-agent-chip"
                  data-selected={viewedAgent?.id === agent.id ? "true" : "false"}
                  style={{ "--agent-color": agent.color } as CSSProperties}
                  onClick={() => selectAgent(agent.id)}
                >
                  <span className="review-agent-dot" aria-hidden="true" />
                  {agent.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="review-hero-copy">
          <span className="label">{viewedAgent ? "Agent branch" : "Candidate branch"}</span>
          <h2>
            <Icon name="branch" size={16} />
            {viewedAgent ? viewedAgent.branch : candidateBranch.name}
          </h2>
          <p>
            {viewedAgent
              ? `Isolated view of ${viewedAgent.name}'s worktree before integration into the candidate branch.`
              : "Review the integrated result of agent worktrees. Approving updates local review status only — nothing is merged or deployed."}
          </p>
        </div>
        <div className="review-hero-facts">
          {viewedAgent ? (
            <>
              <div>
                <span className="label">Owner</span>
                <strong className="value">{viewedAgent.owner}</strong>
              </div>
              <div>
                <span className="label">Base</span>
                <strong className="value">{viewedAgent.baseBranch}</strong>
              </div>
              <div>
                <span className="label">Diff</span>
                <strong>
                  <span className="add">+{diffStat.add}</span> <span className="del">−{diffStat.del}</span>
                </strong>
              </div>
              <div>
                <span className="label">Status</span>
                <strong data-tone={statusTone(viewedAgent.status)}>{statusLabel(viewedAgent.status)}</strong>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
        {viewedAgent ? (
          <p className="review-note">Switch to Target branch to approve the integrated candidate.</p>
        ) : (
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
        )}
      </header>

      <div className="review-grid">
        <aside className="review-pane" aria-label="Changed files">
          <div className="review-pane-head">
            <h3>Files changed</h3>
            <span>{changes.length}</span>
          </div>
          <ul className="review-file-list">
            {changes.map((file) => (
              <li key={file.id}>
                <button
                  type="button"
                  className="review-file"
                  data-selected={selected?.id === file.id ? "true" : "false"}
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
            {selected && (
              <span className="value">
                {selected.path} · {selected.agent}
              </span>
            )}
          </div>
          {selected && <p className="review-summary">{selected.summary}</p>}
          {viewedAgent ? (
            showAgentDiff && agentDiff ? (
              <pre className="review-code" aria-label={`Diff preview for ${agentDiff.path}`}>
                {agentDiff.lines.map((line, index) => (
                  <span key={`${index}-${line.text}`} className="review-line" data-type={line.type}>
                    <i>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</i>
                    <code>{line.text}</code>
                  </span>
                ))}
              </pre>
            ) : (
              selected && <p className="review-empty">No isolated diff preview available for this file yet.</p>
            )
          ) : (
            <pre className="review-code" aria-label={`Diff preview for ${diffPreview.path}`}>
              {diffPreview.lines.map((line, index) => (
                <span key={`${index}-${line.text}`} className="review-line" data-type={line.type}>
                  <i>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</i>
                  <code>{line.text}</code>
                </span>
              ))}
            </pre>
          )}
        </section>

        <aside className="review-side">
          <section className="review-pane" aria-label="Integration warnings">
            <div className="review-pane-head">
              <h3>Integration</h3>
              <span>{warnings.length}</span>
            </div>
            {warnings.length === 0 ? (
              <p className="review-empty">
                {viewedAgent
                  ? `No merge conflicts or integration warnings for ${viewedAgent.name}.`
                  : "No merge conflicts or integration warnings on the candidate."}
              </p>
            ) : (
              <ul className="review-warning-list">
                {warnings.map((warning) =>
                  warning.conflictId ? (
                    <li key={warning.id} data-severity={warning.severity}>
                      <button type="button" className="review-warning-resolve" onClick={() => setOpenConflictId(warning.conflictId!)}>
                        <strong>{warning.title}</strong>
                        <p>{warning.detail}</p>
                        <span className="review-warning-cta">Resolve conflict</span>
                      </button>
                    </li>
                  ) : (
                    <li key={warning.id} data-severity={warning.severity}>
                      <strong>{warning.title}</strong>
                      <p>{warning.detail}</p>
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>

          <section className="review-pane" aria-label="Checks">
            <div className="review-pane-head">
              <h3>Checks</h3>
              <span>
                {passing}/{checks.length}
              </span>
            </div>
            <ul className="review-check-list">
              {checks.map((check) => (
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

          <section className="review-pane review-team-chat" aria-label="Team chat">
            <div className="review-pane-head">
              <h3>Team chat</h3>
              <span>{teamChat.length}</span>
            </div>
            <TeamChat messages={teamChat} onSend={onSendTeamMessage} />
          </section>
        </aside>
      </div>

      {openConflict && (
        <ConflictResolver conflict={openConflict} onResolve={resolveConflict} onClose={() => setOpenConflictId(null)} />
      )}
    </section>
  );
}

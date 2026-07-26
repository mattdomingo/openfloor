"use client";

import { ChangedFile, Check, changedFiles, checks, integrationOrder, repoSummary } from "./data";
import { Icon } from "./primitives";
import { Panel, PanelChrome } from "./Rail";

const fileMarks: Record<ChangedFile["state"], string> = { modified: "M", attention: "!", pending: "…" };

function checkIcon(state: Check["state"]) {
  if (state === "passed") return <Icon name="check" size={12} />;
  if (state === "failed") return <Icon name="alert" size={12} />;
  return <Icon name="clock" size={12} />;
}

export function RepositoryRail({
  chrome,
  tab,
  onTab,
  filter,
  onFilter,
  onNotice,
}: {
  chrome: PanelChrome;
  tab: "changes" | "checks";
  onTab: (tab: "changes" | "checks") => void;
  filter: "all" | "attention";
  onFilter: (filter: "all" | "attention") => void;
  onNotice: (notice: string) => void;
}) {
  const passing = checks.filter((check) => check.state === "passed").length;
  const visible = changedFiles.filter((file) => filter === "all" || file.state === "attention");

  const footer = (
    <>
      <div className="integration-order">
        <span className="label">Integration order</span>
        <ol>
          {integrationOrder.map((name, index) => (
            <li key={name}>
              <b>{index + 1}</b>
              {name}
            </li>
          ))}
        </ol>
      </div>
      <button
        type="button"
        className="button"
        data-variant="primary"
        data-block="true"
        onClick={() => onNotice("Combined diff ready for review")}
      >
        Review combined diff
        <Icon name="external" />
      </button>
    </>
  );

  return (
    <Panel
      chrome={chrome}
      title="Candidate branch"
      meta={`${repoSummary.files} files`}
      badge={`${repoSummary.files}`}
      footer={footer}
    >
      <div className="repo-summary">
        <span>
          <strong>{repoSummary.files}</strong> files
        </span>
        <span className="add">+{repoSummary.additions}</span>
        <span className="del">−{repoSummary.deletions}</span>
        <span className="sync">
          <Icon name="check" size={11} />
          Synced
        </span>
      </div>

      <div className="tabs" role="tablist" aria-label="Repository view">
        <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => onTab("changes")}>
          Changes
        </button>
        <button type="button" role="tab" aria-selected={tab === "checks"} onClick={() => onTab("checks")}>
          Checks
          <b>
            {passing}/{checks.length}
          </b>
        </button>
      </div>

      {tab === "changes" ? (
        <>
          <div className="filter-row" role="group" aria-label="Filter changed files">
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant={filter === "all" ? undefined : "quiet"}
              onClick={() => onFilter("all")}
            >
              All files
            </button>
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant={filter === "attention" ? undefined : "quiet"}
              onClick={() => onFilter("attention")}
            >
              Needs attention
            </button>
          </div>
          <div className="file-list">
            {visible.map((file) => (
              <button
                key={file.path}
                type="button"
                className="file-row"
                onClick={() => onNotice(`Opening combined diff for ${file.path}`)}
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
            ))}
          </div>
        </>
      ) : (
        <div className="check-list">
          {checks.map((check) => (
            <div className="check-row" key={check.id}>
              <span className="check-mark" data-state={check.state}>
                {checkIcon(check.state)}
              </span>
              <div>
                <strong>{check.name}</strong>
                <span>{check.detail}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

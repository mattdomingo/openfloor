"use client";

import { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Agent } from "./data";
import { Icon, StatusDot } from "./primitives";
import { CodeCycleProgress, useAgentCodeCycle } from "./useAgentCodeCycle";

const tokenPattern = /("[^"]*")|\b(export|type|extends|function|return|const|case|new|describe|it|expect)\b/g;

function highlight(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  tokenPattern.lastIndex = 0;
  while ((match = tokenPattern.exec(line)) !== null) {
    if (match.index > cursor) parts.push(line.slice(cursor, match.index));
    parts.push(
      <em key={match.index} data-token={match[1] ? "string" : "keyword"}>
        {match[0]}
      </em>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) parts.push(line.slice(cursor));

  return parts.length > 0 ? parts : [line || " "];
}

/* Renders only the lines typed so far, with a blinking caret at the in-progress line. */
function TypedCode({ lines, progress, limit }: { lines: string[]; progress: CodeCycleProgress; limit?: number }) {
  const visibleCount = Math.min(progress.line + 1, limit ?? lines.length);
  const visible = lines.slice(0, visibleCount);

  return (
    <pre className="code">
      {visible.map((line, index) => {
        const isCurrent = index === progress.line;
        const text = isCurrent ? line.slice(0, progress.chars) : line;
        return (
          <span className="code-line" key={index}>
            <i>{index + 1}</i>
            <code>
              {highlight(text)}
              {isCurrent && <span className="type-caret" aria-hidden="true" />}
            </code>
          </span>
        );
      })}
    </pre>
  );
}

type TreeEntry = { key: string; label: string; depth: number; file: boolean; selected: boolean };

function buildTree(agent: Agent, openPath: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const seen = new Set<string>();

  for (const path of [...agent.files].sort()) {
    const segments = path.split("/");
    const fileName = segments.pop() ?? path;

    segments.forEach((segment, index) => {
      const key = segments.slice(0, index + 1).join("/");
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ key, label: segment, depth: index, file: false, selected: false });
    });

    entries.push({ key: path, label: fileName, depth: segments.length, file: true, selected: path === openPath });
  }

  entries.push({ key: "package.json", label: "package.json", depth: 0, file: true, selected: false });
  entries.push({ key: "README.md", label: "README.md", depth: 0, file: true, selected: false });

  return entries;
}

export function CodeWorkbench({ agent, onNotice }: { agent: Agent; onNotice: (notice: string) => void }) {
  const { files, fileIndex, activeFile, progress } = useAgentCodeCycle(agent);
  const tree = buildTree(agent, activeFile.path);

  return (
    <div className="workbench">
      <aside className="explorer" aria-label={`${agent.name} worktree`}>
        <div className="explorer-head">
          <span className="label">Worktree</span>
          <strong>{agent.name}</strong>
        </div>
        <div className="explorer-branch">
          <Icon name="branch" size={12} />
          {agent.branch}
        </div>
        <div className="tree">
          {tree.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className="tree-row"
              data-depth={Math.min(entry.depth, 2)}
              data-file={entry.file ? "true" : "false"}
              data-selected={entry.selected ? "true" : "false"}
              onClick={() => onNotice(entry.file ? `Opening ${entry.key}` : `Toggled ${entry.key}`)}
            >
              <Icon name={entry.file ? "file" : "chevronDown"} size={11} />
              {entry.label}
            </button>
          ))}
        </div>
        <div className="explorer-scope">
          <span className="label">Write scope</span>
          {agent.files.map((file) => (
            <code key={file}>{file}</code>
          ))}
        </div>
      </aside>

      <section className="editor" aria-label={`${activeFile.path} in ${agent.name} worktree`}>
        <div className="editor-tabs">
          {files.map((file, index) => (
            <span key={file.path} data-active={index === fileIndex ? "true" : undefined}>
              <Icon name="file" size={11} />
              {file.path.split("/").pop()}
            </span>
          ))}
          <span>
            Changes <b>{agent.files.length}</b>
          </span>
        </div>
        <div className="editor-breadcrumb">{activeFile.path.split("/").join("  ›  ")}</div>
        <TypedCode lines={activeFile.lines} progress={progress} />
        <div className="editor-status">
          <span>
            <Icon name="branch" size={11} />
            {agent.branch}
          </span>
          <span>UTF-8 · TypeScript · Ln {progress.line + 1}, Col {progress.chars}</span>
        </div>
      </section>
    </div>
  );
}

const GRID_PREVIEW_LINES = 16;

export function CodeGrid({ agents, onFocusAgent }: { agents: Agent[]; onFocusAgent: (id: string) => void }) {
  return (
    <div className="code-grid">
      {agents.map((agent) => (
        <CodePreviewCard key={agent.id} agent={agent} onFocus={() => onFocusAgent(agent.id)} />
      ))}
    </div>
  );
}

function CodePreviewCard({ agent, onFocus }: { agent: Agent; onFocus: () => void }) {
  const { files, fileIndex, activeFile, progress } = useAgentCodeCycle(agent);
  const openName = activeFile.path.split("/").pop() ?? activeFile.path;
  const hiddenCount = Math.max(activeFile.lines.length - GRID_PREVIEW_LINES, 0);

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onFocus();
  }

  return (
    <article
      className="code-card"
      style={{ "--agent-color": agent.color } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={onKeyDown}
    >
      <div className="code-card-head">
        <span className="agent-glyph" aria-hidden="true">
          {agent.name.slice(0, 1)}
        </span>
        <span className="agent-identity">
          <strong>{agent.name}</strong>
          <span>{agent.branch}</span>
        </span>
        <span className="agent-state">
          <StatusDot status={agent.status} />
        </span>
      </div>

      <div className="code-card-body">
        <div className="editor-tabs">
          <span data-active="true">
            <Icon name="file" size={11} />
            {openName}
          </span>
        </div>
        <div className="editor-breadcrumb">{activeFile.path.split("/").join("  ›  ")}</div>
        <TypedCode lines={activeFile.lines} progress={progress} limit={GRID_PREVIEW_LINES} />
      </div>

      <div className="code-card-foot">
        <span>
          Editing {openName}
          {files.length > 1 ? ` (${fileIndex + 1}/${files.length})` : ""}
          {hiddenCount > 0 ? ` · +${hiddenCount} more lines` : ""}
        </span>
      </div>
    </article>
  );
}

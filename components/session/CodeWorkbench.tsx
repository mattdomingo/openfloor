"use client";

import { CSSProperties, ReactNode, useEffect, useRef } from "react";
import { Agent } from "./data";
import { Icon, StatusDot } from "./primitives";
import { CodeCycleMode, CodeCycleProgress, useAgentCodeCycle } from "./useAgentCodeCycle";

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

/* Write mode renders only the lines typed so far, with a blinking caret at the in-progress
   line. Review mode shows the whole file and walks a highlighted scan line down it. */
function TypedCode({ lines, progress, mode }: { lines: string[]; progress: CodeCycleProgress; mode: CodeCycleMode }) {
  const review = mode === "review";
  const visible = review ? lines : lines.slice(0, progress.line + 1);
  const preRef = useRef<HTMLPreElement>(null);
  const activeLineRef = useRef<HTMLSpanElement>(null);

  // Keep the active line pinned in view as the animation advances down the file.
  useEffect(() => {
    const pre = preRef.current;
    const active = activeLineRef.current;
    if (!pre || !active) return;
    pre.scrollTop = active.offsetTop - pre.offsetTop + active.offsetHeight - pre.clientHeight;
  }, [progress]);

  return (
    <pre className="code" ref={preRef}>
      {visible.map((line, index) => {
        const isCurrent = index === progress.line;
        const text = isCurrent && !review ? line.slice(0, progress.chars) : line;
        return (
          <span
            className="code-line"
            key={index}
            data-reviewing={review && isCurrent ? "true" : undefined}
            ref={isCurrent ? activeLineRef : undefined}
          >
            <i>{index + 1}</i>
            <code>
              {highlight(text)}
              {isCurrent && !review && <span className="type-caret" aria-hidden="true" />}
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
  const { files, fileIndex, activeFile, progress, mode } = useAgentCodeCycle(agent);
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
        <TypedCode lines={activeFile.lines} progress={progress} mode={mode} />
        <div className="editor-status">
          <span>
            <Icon name="branch" size={11} />
            {agent.branch}
          </span>
          <span>
            UTF-8 · TypeScript ·{" "}
            {mode === "review"
              ? `Reviewing Ln ${progress.line + 1} of ${activeFile.lines.length}`
              : `Ln ${progress.line + 1}, Col ${progress.chars}`}
          </span>
        </div>
      </section>
    </div>
  );
}

export function CodeGrid({
  agents,
  onFocusAgent,
  onHistoryAgent,
}: {
  agents: Agent[];
  onFocusAgent: (id: string) => void;
  onHistoryAgent: (id: string) => void;
}) {
  return (
    <div className="code-grid">
      {agents.map((agent) => (
        <CodePreviewCard
          key={agent.id}
          agent={agent}
          onFocus={() => onFocusAgent(agent.id)}
          onHistory={() => onHistoryAgent(agent.id)}
        />
      ))}
    </div>
  );
}

function CodePreviewCard({ agent, onFocus, onHistory }: { agent: Agent; onFocus: () => void; onHistory: () => void }) {
  const { files, fileIndex, activeFile, progress, mode } = useAgentCodeCycle(agent);
  const openName = activeFile.path.split("/").pop() ?? activeFile.path;

  return (
    <article className="code-card" style={{ "--agent-color": agent.color } as CSSProperties} onClick={onFocus}>
      <div className="code-card-head">
        <span className="agent-glyph" aria-hidden="true">
          {agent.name.slice(0, 1)}
        </span>
        <span className="agent-identity">
          <button type="button" className="code-card-focus" onClick={onFocus}>
            {agent.name}
          </button>
          <span>{agent.branch}</span>
        </span>
        <span className="agent-state">
          <StatusDot status={agent.status} />
        </span>
        <button
          type="button"
          className="button agent-chat-button"
          data-size="sm"
          aria-label={`View ${agent.name}'s chat history`}
          title="Chat history"
          onClick={(event) => {
            event.stopPropagation();
            onHistory();
          }}
        >
          <Icon name="message" size={12} />
          Chat
        </button>
      </div>

      <div className="code-card-body">
        <div className="editor-tabs">
          <span data-active="true">
            <Icon name="file" size={11} />
            {openName}
          </span>
        </div>
        <div className="editor-breadcrumb">{activeFile.path.split("/").join("  ›  ")}</div>
        <TypedCode lines={activeFile.lines} progress={progress} mode={mode} />
      </div>

      <div className="code-card-foot">
        <span>
          {mode === "review" ? "Reviewing" : "Editing"} {openName}
          {files.length > 1 ? ` (${fileIndex + 1}/${files.length})` : ""}
          {` · ${activeFile.lines.length} lines`}
        </span>
      </div>
    </article>
  );
}

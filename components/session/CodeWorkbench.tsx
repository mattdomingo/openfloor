"use client";

import { ReactNode } from "react";
import { Agent, codeByAgent } from "./data";
import { Icon } from "./primitives";

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
  const source = codeByAgent[agent.id] ?? codeByAgent.atlas;
  const openName = source.path.split("/").pop() ?? source.path;
  const tree = buildTree(agent, source.path);

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

      <section className="editor" aria-label={`${source.path} in ${agent.name} worktree`}>
        <div className="editor-tabs">
          <span data-active="true">
            <Icon name="file" size={11} />
            {openName}
          </span>
          <span>
            Changes <b>{agent.files.length}</b>
          </span>
        </div>
        <div className="editor-breadcrumb">{source.path.split("/").join("  ›  ")}</div>
        <pre className="code">
          {source.lines.map((line, index) => (
            <span className="code-line" key={`${index}-${line}`}>
              <i>{index + 1}</i>
              <code>{highlight(line)}</code>
            </span>
          ))}
        </pre>
        <div className="editor-status">
          <span>
            <Icon name="branch" size={11} />
            {agent.branch}
          </span>
          <span>UTF-8 · TypeScript · Ln 12, Col 18</span>
        </div>
      </section>
    </div>
  );
}

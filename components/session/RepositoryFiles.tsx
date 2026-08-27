"use client";

import { useEffect, useMemo, useState } from "react";
import type { RepositoryTreeEntry } from "@/lib/github";
import { Icon } from "./primitives";
import type { RepositorySource } from "./useRepositoryTree";

// Shared repository tree UI: the Review screen's "All files" browser and the
// floor's Files rail render the same nodes from the same RepositorySource.

export const DISCONNECTED_REPOSITORY_STATUSES: ReadonlySet<string> = new Set(["disconnected", "revoked", "inaccessible"]);

export type TreeNode = { name: string; path: string; type: "file" | "dir"; children?: TreeNode[] };

/** Groups the flat entry list the tree API returns into a nested structure for disclosure
    rendering, derived purely from file paths so it doesn't depend on GitHub also emitting an
    explicit "dir" entry for every ancestor. */
export function buildFileTree(entries: RepositoryTreeEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirIndex = new Map<string, TreeNode>();
  function ensureDir(path: string): TreeNode[] {
    if (path === "") return root;
    const existing = dirIndex.get(path);
    if (existing) return existing.children!;
    const segments = path.split("/");
    const parentChildren = ensureDir(segments.slice(0, -1).join("/"));
    const node: TreeNode = { name: segments[segments.length - 1], path, type: "dir", children: [] };
    dirIndex.set(path, node);
    parentChildren.push(node);
    return node.children!;
  }
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const segments = entry.path.split("/");
    const parentChildren = ensureDir(segments.slice(0, -1).join("/"));
    parentChildren.push({ name: segments[segments.length - 1], path: entry.path, type: "file" });
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    for (const node of nodes) if (node.children) sortNodes(node.children);
  };
  sortNodes(root);
  return root;
}

export function RepositoryTreeBranch({ nodes, depth, expandedDirs, onToggleDir, selectedPath, onSelectFile }: {
  nodes: TreeNode[];
  depth: number;
  expandedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}) {
  return <ul className="review-tree-list" role="group">
    {nodes.map((node) => node.type === "dir" ? (
      <li key={node.path} role="treeitem" aria-expanded={expandedDirs.has(node.path)} aria-selected="false">
        <button type="button" className="review-tree-dir" style={{ paddingLeft: `${depth * 14 + 8}px` }} onClick={() => onToggleDir(node.path)}>
          <Icon name={expandedDirs.has(node.path) ? "chevronDown" : "chevronRight"} size={12} />
          <span>{node.name}</span>
        </button>
        {expandedDirs.has(node.path) && node.children && <RepositoryTreeBranch nodes={node.children} depth={depth + 1} expandedDirs={expandedDirs} onToggleDir={onToggleDir} selectedPath={selectedPath} onSelectFile={onSelectFile} />}
      </li>
    ) : (
      <li key={node.path} role="treeitem" aria-selected={selectedPath === node.path ? "true" : "false"}>
        <button type="button" className="review-tree-file" data-selected={selectedPath === node.path ? "true" : "false"} style={{ paddingLeft: `${depth * 14 + 8}px` }} onClick={() => onSelectFile(node.path)}>
          <Icon name="file" size={12} />
          <span>{node.name}</span>
        </button>
      </li>
    ))}
  </ul>;
}

/** The floor rail's worktree browser: candidate branch header, the repository
    tree, and an inline preview of the selected file — one column, sized for a
    rail rather than the Review grid. */
export function RepositoryFilesBrowser({ source, browsable, branch }: {
  source: RepositorySource;
  browsable: boolean;
  branch: string | null;
}) {
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const fileTree = useMemo(() => (source.tree ? buildFileTree(source.tree.entries) : []), [source.tree]);

  useEffect(() => {
    if (browsable && source.treeState === "idle") source.load();
  }, [browsable, source]);

  if (!browsable) {
    return <p className="review-empty">Files appear once the session&rsquo;s repository is connected.</p>;
  }

  const selectedFile = selectedPath ? source.fileFor(selectedPath) : null;
  const selectedState = selectedPath ? source.fileStateFor(selectedPath) : "idle";

  return (
    <div className="files-rail">
      {branch && (
        <div className="rail-section-head files-rail-branch">
          <span className="label">Worktree</span>
          <span className="value" title={branch}><Icon name="branch" size={12} /> {branch}</span>
        </div>
      )}
      <div className="files-rail-tree" role="tree" aria-label="Repository files">
        {source.treeState === "loading" || source.treeState === "idle" ? <p className="review-empty">Loading repository files…</p>
          : source.treeState === "error" ? <p className="review-empty">The repository tree could not be loaded.</p>
          : fileTree.length === 0 ? <p className="review-empty">This repository has no files.</p>
          : <>
              <RepositoryTreeBranch nodes={fileTree} depth={0} expandedDirs={expandedDirs} onToggleDir={(path) => setExpandedDirs((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })} selectedPath={selectedPath} onSelectFile={(path) => { setSelectedPath((current) => current === path ? null : path); source.loadFile(path); }} />
              {source.tree?.truncated && <p className="review-empty">Showing a partial file list — this repository is very large.</p>}
            </>}
      </div>
      {selectedPath && (
        <div className="files-rail-preview" aria-label={`File preview for ${selectedPath}`}>
          <div className="rail-section-head files-rail-preview-head">
            <span className="value" title={selectedPath}>{selectedPath.split("/").pop()}</span>
            <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => setSelectedPath(null)}>Close</button>
          </div>
          {selectedState === "idle" || selectedState === "loading" ? <p className="review-empty">Loading file…</p>
            : selectedState === "error" ? <p className="review-empty">This file could not be loaded.</p>
            : selectedFile?.encoding === "text" ? <pre className="review-code files-rail-code">{selectedFile.text.split("\n").map((text, index) => <span key={index} className="review-line" data-type="context"><code>{text}</code></span>)}</pre>
            : selectedFile?.encoding === "too_large" ? <p className="review-empty">This file is too large to preview.</p>
            : <p className="review-empty">This file is binary and can&rsquo;t be previewed.</p>}
        </div>
      )}
    </div>
  );
}

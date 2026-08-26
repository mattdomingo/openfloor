"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { RepositoryFileContent, RepositoryTree } from "@/lib/github";

export type LoadState = "idle" | "loading" | "ready" | "error";

export type RepositorySource = {
  tree: RepositoryTree | null;
  treeState: LoadState;
  /** Idempotent: safe to call every time the Review screen's "All files" tab mounts. */
  load(): void;
  fileFor(path: string): RepositoryFileContent | null;
  fileStateFor(path: string): LoadState;
  /** Idempotent per path: a file already fetched (or in flight) is served from cache. */
  loadFile(path: string): void;
  /** Drops every cached tree/file entry — call when the "repository" floor domain changes,
      since a new candidate head (or a disconnect) invalidates everything read so far. */
  reset(): void;
};

export function useRepositoryTree(sessionId: string): RepositorySource {
  const [tree, setTree] = useState<RepositoryTree | null>(null);
  const [treeState, setTreeState] = useState<LoadState>("idle");
  const [filesByPath, setFilesByPath] = useState<ReadonlyMap<string, RepositoryFileContent>>(new Map());
  const [fileStates, setFileStates] = useState<ReadonlyMap<string, LoadState>>(new Map());
  const treeRequestedRef = useRef(false);
  const fileRequestedRef = useRef(new Set<string>());

  const load = useCallback(() => {
    if (treeRequestedRef.current) return;
    treeRequestedRef.current = true;
    setTreeState("loading");
    void (async () => {
      try {
        const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/tree`, { cache: "no-store" });
        if (!response.ok) {
          setTreeState("error");
          return;
        }
        setTree((await response.json()) as RepositoryTree);
        setTreeState("ready");
      } catch {
        setTreeState("error");
      }
    })();
  }, [sessionId]);

  const loadFile = useCallback((path: string) => {
    if (fileRequestedRef.current.has(path)) return;
    fileRequestedRef.current.add(path);
    setFileStates((current) => new Map(current).set(path, "loading"));
    void (async () => {
      try {
        const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/repository/file?path=${encodeURIComponent(path)}`, { cache: "no-store" });
        if (!response.ok) {
          setFileStates((current) => new Map(current).set(path, "error"));
          return;
        }
        const body = (await response.json()) as RepositoryFileContent;
        setFilesByPath((current) => new Map(current).set(path, body));
        setFileStates((current) => new Map(current).set(path, "ready"));
      } catch {
        setFileStates((current) => new Map(current).set(path, "error"));
      }
    })();
  }, [sessionId]);

  const fileFor = useCallback((path: string) => filesByPath.get(path) ?? null, [filesByPath]);
  const fileStateFor = useCallback((path: string) => fileStates.get(path) ?? "idle", [fileStates]);

  const reset = useCallback(() => {
    treeRequestedRef.current = false;
    fileRequestedRef.current = new Set();
    setTree(null);
    setTreeState("idle");
    setFilesByPath(new Map());
    setFileStates(new Map());
  }, []);

  return useMemo(
    () => ({ tree, treeState, load, fileFor, fileStateFor, loadFile, reset }),
    [tree, treeState, load, fileFor, fileStateFor, loadFile, reset],
  );
}

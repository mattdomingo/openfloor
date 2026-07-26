"use client";

import { useEffect, useMemo, useState } from "react";
import { Agent, agentCodeFiles } from "./data";

const CHAR_INTERVAL_MS = 28;
const HOLD_MS = 1300;

export type CodeCycleProgress = { line: number; chars: number };

/* Simulates an agent typing through the files in its scope, one character at a time, looping
   through its file library forever. Used to animate codebase mode as if edits are live.
   Mount this behind a `key={agent.id}` at the call site so switching agents resets the cycle. */
export function useAgentCodeCycle(agent: Agent) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed by id, not agent identity
  const files = useMemo(() => agentCodeFiles(agent), [agent.id]);
  const [fileIndex, setFileIndex] = useState(0);
  const [progress, setProgress] = useState<CodeCycleProgress>({ line: 0, chars: 0 });
  const [typedForIndex, setTypedForIndex] = useState(0);
  const activeFile = files[fileIndex % files.length];

  // Reset typing progress when the active file changes, following React's render-time
  // state-reset pattern instead of an effect (avoids an extra render-then-reset cascade).
  if (typedForIndex !== fileIndex) {
    setTypedForIndex(fileIndex);
    setProgress({ line: 0, chars: 0 });
  }

  useEffect(() => {
    const lines = activeFile.lines;
    const lastLine = Math.max(lines.length - 1, 0);
    const lastLineLength = lines[lastLine]?.length ?? 0;
    const atEnd = progress.line >= lastLine && progress.chars >= lastLineLength;

    if (atEnd) {
      const hold = window.setTimeout(() => setFileIndex((index) => index + 1), HOLD_MS);
      return () => window.clearTimeout(hold);
    }

    const tick = window.setTimeout(() => {
      setProgress((current) => {
        const text = lines[current.line] ?? "";
        if (current.chars < text.length) return { line: current.line, chars: current.chars + 1 };
        return { line: current.line + 1, chars: 0 };
      });
    }, CHAR_INTERVAL_MS);
    return () => window.clearTimeout(tick);
  }, [progress, activeFile]);

  return { files, fileIndex: fileIndex % files.length, activeFile, progress };
}

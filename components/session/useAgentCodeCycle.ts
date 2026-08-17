"use client";

import { useEffect, useMemo, useState } from "react";
import { Agent, agentCodeFiles } from "./data";

const CHAR_INTERVAL_MS = 28;
const REVIEW_LINE_INTERVAL_MS = 320;
const HOLD_MS = 1300;

export type CodeCycleProgress = { line: number; chars: number };
export type CodeCycleMode = "write" | "review";

/* Simulates an agent working through the files in its scope, looping through its file
   library forever. Writers type one character at a time; reviewers scan a fully visible
   file one line at a time. Used to animate codebase mode as if the work is live.
   Mount this behind a `key={agent.id}` at the call site so switching agents resets the cycle. */
export function useAgentCodeCycle(agent: Agent) {
  const mode: CodeCycleMode = agent.role === "Reviewer" ? "review" : "write";
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
    const atEnd =
      mode === "review"
        ? progress.line >= lastLine
        : progress.line >= lastLine && progress.chars >= lastLineLength;

    if (atEnd) {
      const hold = window.setTimeout(() => setFileIndex((index) => index + 1), HOLD_MS);
      return () => window.clearTimeout(hold);
    }

    const tick = window.setTimeout(
      () => {
        setProgress((current) => {
          if (mode === "review") return { line: current.line + 1, chars: 0 };
          const text = lines[current.line] ?? "";
          if (current.chars < text.length) return { line: current.line, chars: current.chars + 1 };
          return { line: current.line + 1, chars: 0 };
        });
      },
      mode === "review" ? REVIEW_LINE_INTERVAL_MS : CHAR_INTERVAL_MS,
    );
    return () => window.clearTimeout(tick);
  }, [progress, activeFile, mode]);

  return { files, fileIndex: fileIndex % files.length, activeFile, progress, mode };
}

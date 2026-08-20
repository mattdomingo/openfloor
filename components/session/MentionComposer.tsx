"use client";

import { KeyboardEvent, ReactNode, RefObject, SyntheticEvent, useMemo, useState } from "react";
import type { FloorAgent } from "@/lib/floor-types";

function findMentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /@([A-Za-z][\w-]*)$/.exec(before);
  if (!match) return null;
  if (match.index > 0 && !/\s/.test(before[match.index - 1])) return null;
  return { start: match.index, query: match[1] };
}

/* Renders the same text as the textarea beneath it, with @mentions recolored.
   The trailing zero-width space keeps a trailing newline from collapsing the
   div's height relative to the textarea it mirrors. */
function renderHighlight(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(^|\s)(@[A-Za-z][\w-]*)/g;
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const start = match.index + match[1].length;
    if (start > lastIndex) nodes.push(<span key={key++}>{value.slice(lastIndex, start)}</span>);
    nodes.push(<span key={key++} className="mention-tag">{match[2]}</span>);
    lastIndex = start + match[2].length;
  }
  nodes.push(<span key={key++}>{value.slice(lastIndex)}</span>);
  nodes.push("​");
  return nodes;
}

export function MentionComposer({
  ariaLabel,
  agents,
  textareaRef,
  value,
  onValueChange,
}: {
  ariaLabel: string;
  agents: FloorAgent[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const mention = findMentionQuery(value, caret);

  const suggestions = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const query = mention.query.toLocaleLowerCase("en-US");
    return agents.filter((agent) => agent.name.toLocaleLowerCase("en-US").startsWith(query)).slice(0, 6);
  }, [agents, mention, dismissedAt]);

  // Reset keyboard selection whenever the mention token changes, without an
  // effect: adjusting state during render (React's documented pattern) skips
  // the extra commit an effect-driven reset would cause.
  const mentionKey = mention ? `${mention.start}:${mention.query}` : null;
  const [lastMentionKey, setLastMentionKey] = useState<string | null>(null);
  if (mentionKey !== lastMentionKey) {
    setLastMentionKey(mentionKey);
    if (activeIndex !== 0) setActiveIndex(0);
  }

  function syncCaret(event: SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(event.currentTarget.selectionStart ?? 0);
  }

  function pickSuggestion(agent: FloorAgent) {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after = value.slice(mention.start + 1 + mention.query.length);
    const inserted = `@${agent.name} `;
    onValueChange(`${before}${inserted}${after}`);
    const cursor = before.length + inserted.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
      setCaret(cursor);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => (index + 1) % suggestions.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pickSuggestion(suggestions[activeIndex]); return; }
      if (event.key === "Escape") { event.preventDefault(); setDismissedAt(mention?.start ?? null); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="mention-field" data-agent-count={agents.length}>
      <div className="mention-highlight" aria-hidden="true">{renderHighlight(value)}</div>
      <textarea
        ref={textareaRef}
        className="mention-input"
        value={value}
        onKeyDown={handleKeyDown}
        onChange={(event) => { onValueChange(event.currentTarget.value); syncCaret(event); }}
        onSelect={syncCaret}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        maxLength={4_000}
        aria-label={ariaLabel}
        aria-autocomplete="list"
      />
      {suggestions.length > 0 && (
        <ul className="mention-suggestions" role="listbox">
          {suggestions.map((agent, index) => (
            <li key={agent.id} role="option" aria-selected={index === activeIndex}>
              <button type="button" data-active={index === activeIndex ? "true" : undefined} onMouseDown={(event) => { event.preventDefault(); pickSuggestion(agent); }}>
                {agent.name}<span className="mention-suggestion-role">{agent.role}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

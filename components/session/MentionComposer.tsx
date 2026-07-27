"use client";

import { ChangeEvent, KeyboardEvent, ReactNode, RefObject, UIEvent, useMemo, useRef, useState } from "react";
import { Agent, MENTION_TOKEN } from "./data";

/* An "@Word" still being typed at the caret, with no closing space yet. */
const MENTION_IN_PROGRESS = /@([A-Za-z][\w-]*)?$/;

function highlight(text: string, agents: Agent[]): ReactNode[] {
  const names = new Set(agents.map((agent) => agent.name.toLowerCase()));
  const pattern = new RegExp(MENTION_TOKEN.source, "g");
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const known = names.has(match[1].toLowerCase());
    parts.push(
      <span key={match.index} className={known ? "mention-tag" : undefined}>
        {match[0]}
      </span>,
    );
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  // A textarea clips a trailing newline's empty last line; matching that here keeps the overlay aligned.
  if (text.endsWith("\n")) parts.push(" ");

  return parts;
}

export function MentionComposer({
  value,
  onChange,
  placeholder,
  ariaLabel,
  agents,
  textareaRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  agents: Agent[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [caretPos, setCaretPos] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const highlightRef = useRef<HTMLDivElement>(null);

  const mentionQuery = useMemo(() => {
    const match = value.slice(0, caretPos).match(MENTION_IN_PROGRESS);
    return match ? (match[1] ?? "") : null;
  }, [value, caretPos]);

  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    return agents.filter((agent) => agent.name.toLowerCase().startsWith(mentionQuery.toLowerCase()));
  }, [mentionQuery, agents]);

  const showSuggestions = mentionQuery !== null && suggestions.length > 0 && !dismissed;
  const activeSuggestion = suggestions[activeIndex % Math.max(suggestions.length, 1)];

  function syncCaret(target: HTMLTextAreaElement) {
    setCaretPos(target.selectionStart ?? 0);
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onChange(event.target.value);
    syncCaret(event.target);
    setActiveIndex(0);
    setDismissed(false);
  }

  function selectSuggestion(agent: Agent) {
    const upToCaret = value.slice(0, caretPos);
    const afterCaret = value.slice(caretPos);
    const replaced = upToCaret.replace(MENTION_IN_PROGRESS, `@${agent.name} `);
    onChange(replaced + afterCaret);

    const nextCaret = replaced.length;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
      setCaretPos(nextCaret);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!showSuggestions) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectSuggestion(activeSuggestion);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  }

  function handleScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (highlightRef.current) highlightRef.current.scrollTop = event.currentTarget.scrollTop;
  }

  return (
    <div className="mention-field">
      <div className="mention-highlight" ref={highlightRef} aria-hidden="true">
        {highlight(value, agents)}
      </div>
      <textarea
        ref={textareaRef}
        className="mention-input"
        value={value}
        onChange={handleChange}
        onSelect={(event) => syncCaret(event.currentTarget)}
        onKeyDown={handleKeyDown}
        onScroll={handleScroll}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />

      {showSuggestions && (
        <ul className="mention-suggestions" role="listbox" aria-label="Mention an agent">
          {suggestions.map((agent, index) => (
            <li key={agent.id} role="option" aria-selected={index === activeIndex % suggestions.length}>
              <button
                type="button"
                data-active={index === activeIndex % suggestions.length ? "true" : "false"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectSuggestion(agent)}
              >
                {agent.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

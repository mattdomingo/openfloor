"use client";

import { KeyboardEvent, RefObject } from "react";
import type { Agent } from "./data";

export function MentionComposer({
  placeholder,
  ariaLabel,
  agents,
  textareaRef,
}: {
  placeholder: string;
  ariaLabel: string;
  agents: Agent[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="mention-field" data-agent-count={agents.length}>
      <textarea
        ref={textareaRef}
        className="mention-input"
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}

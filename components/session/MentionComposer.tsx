"use client";

import { KeyboardEvent, RefObject } from "react";
import type { FloorAgent } from "@/lib/floor-types";

export function MentionComposer({
  ariaLabel,
  agents,
  textareaRef,
  onValueChange,
}: {
  ariaLabel: string;
  agents: FloorAgent[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onValueChange?: (value: string) => void;
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
        onInput={(event) => onValueChange?.(event.currentTarget.value)}
        maxLength={4_000}
        aria-label={ariaLabel}
      />
    </div>
  );
}

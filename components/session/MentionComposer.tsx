"use client";

import { KeyboardEvent, RefObject } from "react";
import type { FloorAgent } from "@/lib/floor-types";

export function MentionComposer({
  ariaLabel,
  agents,
  textareaRef,
}: {
  ariaLabel: string;
  agents: FloorAgent[];
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
        aria-label={ariaLabel}
      />
    </div>
  );
}

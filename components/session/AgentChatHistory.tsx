"use client";

import type { FloorAgent, FloorQueueItem } from "@/lib/floor-types";
import { LocalDateTime } from "@/components/LocalDateTime";
import { Avatar, Icon, useDialogDismiss } from "./primitives";
import { initials } from "./data";
import { Markdown } from "./Markdown";

export function AgentChatHistory({ agent, queue, onClose }: { agent: FloorAgent; queue: FloorQueueItem[]; onClose: () => void }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const prompts = queue.filter((item) => item.agentId === agent.id).flatMap((item) => item.prompts);
  return (
    <dialog className="dialog chat-history" {...dialogProps}>
      <div className="dialog-head"><div className="dialog-title"><h2>Prompt history</h2><p>{agent.name}</p></div><button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button></div>
      <div className="dialog-body">
        {prompts.length === 0 ? <p className="review-empty">No prompts have been sent to {agent.name}.</p> : (
          <ol className="chat-thread">{prompts.map((prompt) => <li key={prompt.id} className="chat-message" data-role="prompt"><Avatar userId={prompt.authorUserId} initials={initials(prompt.authorName)} tone="you" /><div className="chat-bubble"><div className="chat-bubble-head"><strong>{prompt.authorName}</strong><span><LocalDateTime timestamp={prompt.createdAt} /></span></div><Markdown className="chat-markdown">{prompt.text}</Markdown></div></li>)}</ol>
        )}
      </div>
    </dialog>
  );
}

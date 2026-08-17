"use client";

import { CSSProperties } from "react";
import { Agent, ChatMessage, agentChatMessages } from "./data";
import { Avatar, Icon, useDialogDismiss } from "./primitives";

export function AgentChatHistory({
  agent,
  extraMessages = [],
  onClose,
}: {
  agent: Agent;
  extraMessages?: ChatMessage[];
  onClose: () => void;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const messages = [...agentChatMessages(agent), ...extraMessages];

  return (
    <dialog className="dialog chat-history" {...dialogProps}>
      <div className="dialog-head">
        <div className="dialog-title">
          <h2>Chat history</h2>
          <p>
            <span>{agent.name}</span>
            <Icon name="branch" size={12} />
            <span className="value">{agent.branch}</span>
          </p>
        </div>
        <button type="button" className="dialog-close" onClick={dismiss} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>

      <div className="dialog-body">
        {messages.length === 0 ? (
          <p className="review-empty">No prompts have been sent to {agent.name} yet.</p>
        ) : (
          <ol className="chat-thread" style={{ "--agent-color": agent.color } as CSSProperties}>
            {messages.map((message) => (
              <li key={message.id} className="chat-message" data-role={message.role}>
                {message.role === "prompt" ? (
                  <Avatar initials={message.author.slice(0, 1)} tone={message.authorTone ?? "you"} />
                ) : (
                  <span className="agent-glyph" data-size="sm" aria-hidden="true">
                    {agent.name.slice(0, 1)}
                  </span>
                )}
                <div className="chat-bubble">
                  <div className="chat-bubble-head">
                    <strong>{message.author}</strong>
                    <span>{message.time}</span>
                  </div>
                  <p>{message.text}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </dialog>
  );
}

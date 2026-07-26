"use client";

import { CSSProperties, useEffect, useRef } from "react";
import { Agent, agentChatMessages } from "./data";
import { Avatar, Icon } from "./primitives";

export function AgentChatHistory({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const messages = agentChatMessages(agent);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return (
    <dialog className="dialog chat-history" ref={dialogRef} onClose={onClose}>
      <div className="dialog-head">
        <div className="dialog-title">
          <h2>Chat history</h2>
          <p>
            {agent.name} <Icon name="branch" size={12} />
            {agent.branch}
          </p>
        </div>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
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

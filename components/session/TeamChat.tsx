"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { TeamChatMessage } from "./data";
import { Avatar, Icon } from "./primitives";

export function TeamChat({ messages, onSend }: { messages: TeamChatMessage[]; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  return (
    <div className="team-chat">
      <div className="team-chat-list" ref={listRef}>
        {messages.map((message) => (
          <div className="team-chat-message" key={message.id}>
            <Avatar initials={message.authorName.slice(0, 1)} tone={message.authorTone} />
            <div className="team-chat-body">
              <div className="team-chat-head">
                <strong>{message.authorName}</strong>
                <span>{message.time}</span>
              </div>
              <p>{message.text}</p>
            </div>
          </div>
        ))}
      </div>

      <form className="team-chat-composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message the team…"
          aria-label="Message the team"
          rows={1}
        />
        <button type="submit" className="icon-button" aria-label="Send message" title="Send">
          <Icon name="send" size={14} />
        </button>
      </form>
    </div>
  );
}

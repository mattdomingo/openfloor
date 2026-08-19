"use client";

import { useRef, useState } from "react";
import type { FloorParticipant } from "@/lib/floor-types";
import { Agent, AgentDraft, AgentLayout, ChatMessage, suggestAgentName } from "./data";
import { Icon, SegmentedControl, StatusDot } from "./primitives";
import { Panel, PanelChrome } from "./Rail";
import { AgentCard, AgentSpotlight } from "./AgentCard";
import { AgentChatHistory } from "./AgentChatHistory";
import { CreateAgentDialog } from "./CreateAgentDialog";

export function AgentFloor({
  chrome,
  agents,
  selected,
  onSelect,
  agentLayout,
  onAgentLayout,
  onCreateAgent,
  onNotice,
  onAnswer,
  qMessages,
  participants,
  currentUserName,
}: {
  chrome: PanelChrome;
  agents: Agent[];
  selected: Agent;
  onSelect: (id: string) => void;
  agentLayout: AgentLayout;
  onAgentLayout: (layout: AgentLayout) => void;
  onCreateAgent: (draft: AgentDraft) => void;
  onNotice: (notice: string) => void;
  onAnswer: (agent: Agent) => void;
  qMessages: ChatMessage[];
  participants: FloorParticipant[];
  currentUserName: string;
}) {
  const [creating, setCreating] = useState(false);
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const working = agents.filter((agent) => agent.status !== "complete" && agent.status !== "idle").length;
  const historyAgent = agents.find((agent) => agent.id === historyAgentId) ?? null;

  function closeDialog() {
    setCreating(false);
    createButtonRef.current?.focus();
  }

  const controls = (
    <SegmentedControl
      label="Agent layout"
      value={agentLayout}
      onChange={onAgentLayout}
      options={[{ value: "focus", label: "Focused" }, { value: "all", label: "All agents" }]}
    />
  );

  return (
    <>
      <Panel chrome={chrome} title="Agent floor" meta={`Activity · ${working} working`} badge={`${working}`} actions={controls}>
        <p className="floor-lede">Prototype agents and their current work. This state resets when the page reloads.</p>
        <div className="chip-row">
          <button ref={createButtonRef} type="button" className="chip chip-create" onClick={() => setCreating(true)}>
            <Icon name="plus" size={11} />New agent
          </button>
          {agentLayout === "focus" && (
            <><span className="chip-divider" aria-hidden="true" /><div className="chip-group" role="group" aria-label="Select an agent">
              {agents.map((agent) => (
                <button key={agent.id} type="button" className="chip" aria-pressed={selected.id === agent.id} onClick={() => onSelect(agent.id)}>
                  <StatusDot status={agent.status} />{agent.name}
                </button>
              ))}
            </div></>
          )}
        </div>

        {agentLayout === "all" ? (
          <div className="agent-grid">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} selected={selected.id === agent.id} onFocus={() => { onSelect(agent.id); onAgentLayout("focus"); }} onHistory={() => setHistoryAgentId(agent.id)} />
            ))}
          </div>
        ) : (
          <AgentSpotlight agent={selected} onNotice={onNotice} onAnswer={onAnswer} onHistory={() => setHistoryAgentId(selected.id)} />
        )}
      </Panel>

      {creating && (
        <CreateAgentDialog suggestedName={suggestAgentName(agents)} participants={participants} currentUserName={currentUserName} onClose={closeDialog} onCreate={onCreateAgent} />
      )}
      {historyAgent && (
        <AgentChatHistory agent={historyAgent} extraMessages={historyAgent.id === "q" || historyAgent.parentId === "q" ? qMessages : undefined} onClose={() => setHistoryAgentId(null)} />
      )}
    </>
  );
}

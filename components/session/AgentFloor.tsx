"use client";

import { useRef, useState } from "react";
import { Agent, AgentDraft, AgentLayout, CenterMode, ChatMessage, suggestAgentName } from "./data";
import { Icon, SegmentedControl, StatusDot } from "./primitives";
import { Panel, PanelChrome } from "./Rail";
import { AgentCard, AgentSpotlight } from "./AgentCard";
import { AgentChatHistory } from "./AgentChatHistory";
import { CodeGrid, CodeWorkbench } from "./CodeWorkbench";
import { CreateAgentDialog } from "./CreateAgentDialog";

export function AgentFloor({
  chrome,
  agents,
  selected,
  onSelect,
  centerMode,
  onCenterMode,
  agentLayout,
  onAgentLayout,
  onCreateAgent,
  onNotice,
  onAnswer,
  qMessages,
}: {
  chrome: PanelChrome;
  agents: Agent[];
  selected: Agent;
  onSelect: (id: string) => void;
  centerMode: CenterMode;
  onCenterMode: (mode: CenterMode) => void;
  agentLayout: AgentLayout;
  onAgentLayout: (layout: AgentLayout) => void;
  onCreateAgent: (draft: AgentDraft) => void;
  onNotice: (notice: string) => void;
  onAnswer: (agent: Agent) => void;
  qMessages: ChatMessage[];
}) {
  const [creating, setCreating] = useState(false);
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const working = agents.filter((agent) => agent.status !== "complete" && agent.status !== "idle").length;
  const showPicker = agentLayout === "focus";
  const historyAgent = agents.find((agent) => agent.id === historyAgentId) ?? null;

  // Only workers have code/worktrees; the orchestrator and Q&A service sit out of codebase mode.
  const workerAgents = agents.filter((agent) => agent.kind === "worker");
  const pickerAgents = centerMode === "codebase" ? workerAgents : agents;
  const codebaseAgent = selected.kind === "worker" ? selected : workerAgents[0];

  function closeDialog() {
    setCreating(false);
    createButtonRef.current?.focus();
  }

  const controls = (
    <div className="floor-controls">
      <SegmentedControl
        label="Floor view"
        value={centerMode}
        onChange={onCenterMode}
        options={[
          { value: "activity", label: "Activity" },
          { value: "codebase", label: "Codebase" },
        ]}
      />
      <SegmentedControl
        label="Agent layout"
        value={agentLayout}
        onChange={onAgentLayout}
        options={[
          { value: "focus", label: "Focused" },
          { value: "all", label: "All agents" },
        ]}
      />
    </div>
  );

  return (
    <>
      <Panel chrome={chrome} title="Agent floor" meta={`Activity · ${working} working`} badge={`${working}`} actions={controls}>
        <p className="floor-lede">Agents currently performing work. Submitted prompts wait in the Queue.</p>
        <div className="chip-row">
          <button ref={createButtonRef} type="button" className="chip chip-create" onClick={() => setCreating(true)}>
            <Icon name="plus" size={11} />
            New agent
          </button>
          {showPicker && (
            <>
              <span className="chip-divider" aria-hidden="true" />
              <div className="chip-group" role="group" aria-label="Select an agent">
                {pickerAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className="chip"
                    aria-pressed={selected.id === agent.id}
                    onClick={() => onSelect(agent.id)}
                  >
                    <StatusDot status={agent.status} />
                    {agent.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {centerMode === "codebase" ? (
          agentLayout === "all" ? (
            <CodeGrid
              agents={workerAgents}
              onFocusAgent={(id) => {
                onSelect(id);
                onAgentLayout("focus");
              }}
              onHistoryAgent={setHistoryAgentId}
            />
          ) : (
            <CodeWorkbench key={codebaseAgent.id} agent={codebaseAgent} onNotice={onNotice} />
          )
        ) : agentLayout === "all" ? (
          <div className="agent-grid">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={selected.id === agent.id}
                onFocus={() => {
                  onSelect(agent.id);
                  onAgentLayout("focus");
                }}
                onHistory={() => setHistoryAgentId(agent.id)}
              />
            ))}
          </div>
        ) : (
          <AgentSpotlight
            agent={selected}
            onNotice={onNotice}
            onAnswer={onAnswer}
            onHistory={() => setHistoryAgentId(selected.id)}
          />
        )}
      </Panel>

      {creating && (
        <CreateAgentDialog
          suggestedName={suggestAgentName(agents)}
          onClose={closeDialog}
          onCreate={(draft) => {
            onCreateAgent(draft);
          }}
        />
      )}

      {historyAgent && (
        <AgentChatHistory
          agent={historyAgent}
          extraMessages={historyAgent.id === "q" || historyAgent.parentId === "q" ? qMessages : undefined}
          onClose={() => setHistoryAgentId(null)}
        />
      )}
    </>
  );
}

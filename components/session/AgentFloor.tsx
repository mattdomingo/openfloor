"use client";

import { useRef, useState } from "react";
import { Agent, AgentDraft, AgentLayout, CenterMode, suggestAgentName } from "./data";
import { Icon, SegmentedControl, StatusDot } from "./primitives";
import { Panel, PanelChrome } from "./Rail";
import { AgentCard, AgentSpotlight } from "./AgentCard";
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
}) {
  const [creating, setCreating] = useState(false);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const working = agents.filter((agent) => agent.status !== "complete").length;
  const showPicker = agentLayout === "focus";

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
                {agents.map((agent) => (
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
              agents={agents}
              onFocusAgent={(id) => {
                onSelect(id);
                onAgentLayout("focus");
              }}
            />
          ) : (
            <CodeWorkbench key={selected.id} agent={selected} onNotice={onNotice} />
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
              />
            ))}
          </div>
        ) : (
          <AgentSpotlight agent={selected} onNotice={onNotice} />
        )}
      </Panel>

      {creating && (
        <CreateAgentDialog
          suggestedName={suggestAgentName(agents)}
          onClose={closeDialog}
          onCreate={(draft) => {
            onCreateAgent(draft);
            closeDialog();
          }}
        />
      )}
    </>
  );
}

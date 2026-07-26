"use client";

import { Agent, AgentLayout, CenterMode } from "./data";
import { SegmentedControl, StatusDot } from "./primitives";
import { Panel, PanelChrome } from "./Rail";
import { AgentCard, AgentSpotlight } from "./AgentCard";
import { CodeWorkbench } from "./CodeWorkbench";

export function AgentFloor({
  chrome,
  agents,
  selected,
  onSelect,
  centerMode,
  onCenterMode,
  agentLayout,
  onAgentLayout,
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
  onNotice: (notice: string) => void;
}) {
  const working = agents.filter((agent) => agent.status !== "complete").length;
  const showPicker = centerMode === "codebase" || agentLayout === "focus";

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
      {centerMode === "activity" && (
        <SegmentedControl
          label="Agent layout"
          value={agentLayout}
          onChange={onAgentLayout}
          options={[
            { value: "focus", label: "Focused" },
            { value: "all", label: "All agents" },
          ]}
        />
      )}
    </div>
  );

  return (
    <Panel chrome={chrome} title="Agent floor" meta={`${working} working`} badge={`${working}`} actions={controls}>
      {showPicker && (
        <div className="chip-row" role="group" aria-label="Select an agent">
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
      )}

      {centerMode === "codebase" ? (
        <CodeWorkbench agent={selected} onNotice={onNotice} />
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
  );
}

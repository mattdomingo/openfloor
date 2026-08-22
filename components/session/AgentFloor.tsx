"use client";

import { useRef, useState } from "react";
import type { AgentRun, CreateFloorAgentInput, FloorAgent, FloorParticipant, FloorQueueItem } from "@/lib/floor-types";
import type { AgentLayout } from "./data";
import { agentTone } from "./data";
import { HoverTip, Icon, useHoverTip } from "./primitives";
import { Panel, type PanelChrome } from "./Rail";
import { AgentCard, AgentSpotlight } from "./AgentCard";
import type { RunActivitySource } from "./useRunActivity";
import { AgentChatHistory } from "./AgentChatHistory";
import { CreateAgentDialog } from "./CreateAgentDialog";

function AgentRailItem({ agent, selected, onSelect }: { agent: FloorAgent; selected: boolean; onSelect: () => void }) {
  const tip = useHoverTip();
  return (
    <>
      <button
        type="button"
        className="agent-rail-item"
        data-tone={agentTone(agent.id)}
        data-selected={selected ? "true" : "false"}
        role="tab"
        aria-selected={selected}
        aria-label={agent.name}
        onClick={onSelect}
        {...tip.handlers}
      >
        {agent.name.slice(0, 1)}
      </button>
      <HoverTip position={tip.position}>{agent.name}</HoverTip>
    </>
  );
}

function AllAgentsButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const tip = useHoverTip();
  return (
    <>
      <button type="button" className="agent-rail-item agent-rail-all" data-selected={active ? "true" : "false"} aria-pressed={active} aria-label="All agents" onClick={onClick} {...tip.handlers}>
        <Icon name="grid" size={13} />
      </button>
      <HoverTip position={tip.position}>All agents</HoverTip>
    </>
  );
}

export function AgentFloor({ chrome, sessionId, agents, runs, activity, selected, onSelect, agentLayout, onAgentLayout, onCreateAgent, onUpdateTask, queue, participants, currentUserId, claudeRunEnabled }: {
  chrome: PanelChrome;
  sessionId: string;
  agents: FloorAgent[];
  runs: AgentRun[];
  activity: RunActivitySource;
  selected: FloorAgent | null;
  onSelect: (id: string) => void;
  agentLayout: AgentLayout;
  onAgentLayout: (layout: AgentLayout) => void;
  onCreateAgent: (input: CreateFloorAgentInput) => Promise<boolean>;
  onUpdateTask: (agentId: string, task: string) => Promise<boolean>;
  queue: FloorQueueItem[];
  participants: FloorParticipant[];
  currentUserId: string;
  claudeRunEnabled: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const historyAgent = agents.find((agent) => agent.id === historyAgentId) ?? null;

  function focusAgent(id: string) {
    onSelect(id);
    onAgentLayout("focus");
  }

  const headerActions = (
    <>
      {agents.length > 0 && (
        <div className="agent-header-rail" role="tablist" aria-label="Agents">
          {agents.map((agent) => (
            <AgentRailItem key={agent.id} agent={agent} selected={agentLayout === "focus" && selected?.id === agent.id} onSelect={() => focusAgent(agent.id)} />
          ))}
        </div>
      )}
      {agents.length > 0 && <AllAgentsButton active={agentLayout === "all"} onClick={() => onAgentLayout("all")} />}
      <button ref={createButtonRef} type="button" className="chip chip-create" onClick={() => setCreating(true)}><Icon name="plus" size={11} />New agent</button>
    </>
  );

  return <>
    <Panel chrome={chrome} title="Agent floor" actions={headerActions}>
      {agents.length === 0 ? (
        <div className="floor-empty"><strong>No agents yet</strong><p>Create an agent when the session has work to assign.</p><button type="button" className="button" data-variant="primary" onClick={() => setCreating(true)}>Create agent</button></div>
      ) : agentLayout === "all" ? (
        <div className="agent-grid">{agents.map((agent) => { const latestRun = runs.find((run) => run.agentId === agent.id) ?? null; return <AgentCard key={agent.id} agent={agent} latestRun={latestRun} activityEvents={latestRun ? activity.eventsFor(latestRun.id) : []} selected={selected?.id === agent.id} onFocus={() => focusAgent(agent.id)} onHistory={() => setHistoryAgentId(agent.id)} />; })}</div>
      ) : selected ? (
        <AgentSpotlight agent={selected} sessionId={sessionId} latestRun={runs.find((run) => run.agentId === selected.id) ?? null} activity={activity} onHistory={() => setHistoryAgentId(selected.id)} onUpdateTask={onUpdateTask} />
      ) : null}
    </Panel>
    {creating && <CreateAgentDialog participants={participants} currentUserId={currentUserId} claudeRunEnabled={claudeRunEnabled} onClose={() => { setCreating(false); createButtonRef.current?.focus(); }} onCreate={onCreateAgent} />}
    {historyAgent && <AgentChatHistory agent={historyAgent} queue={queue} onClose={() => setHistoryAgentId(null)} />}
  </>;
}

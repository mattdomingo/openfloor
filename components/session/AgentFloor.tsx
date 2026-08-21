"use client";

import { useRef, useState } from "react";
import type { AgentRun, CreateFloorAgentInput, FloorAgent, FloorParticipant, FloorQueueItem } from "@/lib/floor-types";
import type { AgentLayout } from "./data";
import { Icon, SegmentedControl } from "./primitives";
import { Panel, type PanelChrome } from "./Rail";
import { AgentCard, AgentSpotlight } from "./AgentCard";
import type { RunActivitySource } from "./useRunActivity";
import { AgentChatHistory } from "./AgentChatHistory";
import { CreateAgentDialog } from "./CreateAgentDialog";

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
  const controls = agents.length > 0 ? <SegmentedControl label="Agent layout" value={agentLayout} onChange={onAgentLayout} options={[{ value: "focus", label: "Focused" }, { value: "all", label: "All agents" }]} /> : undefined;

  return <>
    <Panel chrome={chrome} title="Agent floor" badge={`${agents.length}`} actions={controls}>
      <div className="chip-row"><button ref={createButtonRef} type="button" className="chip chip-create" onClick={() => setCreating(true)}><Icon name="plus" size={11} />New agent</button></div>
      {agents.length === 0 ? (
        <div className="floor-empty"><strong>No agents yet</strong><p>Create an agent when the session has work to assign.</p><button type="button" className="button" data-variant="primary" onClick={() => setCreating(true)}>Create agent</button></div>
      ) : agentLayout === "all" ? (
        <div className="agent-grid">{agents.map((agent) => { const latestRun = runs.find((run) => run.agentId === agent.id) ?? null; return <AgentCard key={agent.id} agent={agent} latestRun={latestRun} activityEvents={latestRun ? activity.eventsFor(latestRun.id) : []} selected={selected?.id === agent.id} onFocus={() => { onSelect(agent.id); onAgentLayout("focus"); }} onHistory={() => setHistoryAgentId(agent.id)} />; })}</div>
      ) : selected ? <AgentSpotlight agent={selected} agents={agents} sessionId={sessionId} latestRun={runs.find((run) => run.agentId === selected.id) ?? null} activity={activity} onHistory={() => setHistoryAgentId(selected.id)} onSelect={onSelect} onUpdateTask={onUpdateTask} /> : null}
    </Panel>
    {creating && <CreateAgentDialog participants={participants} currentUserId={currentUserId} claudeRunEnabled={claudeRunEnabled} onClose={() => { setCreating(false); createButtonRef.current?.focus(); }} onCreate={onCreateAgent} />}
    {historyAgent && <AgentChatHistory agent={historyAgent} queue={queue} onClose={() => setHistoryAgentId(null)} />}
  </>;
}

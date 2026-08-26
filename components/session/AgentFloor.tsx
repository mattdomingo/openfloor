"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { AGENT_PROVIDER_LABELS, connectedProviders, type CredentialProvider, type ProviderCredentialSummary } from "@/lib/provider-credentials";
import type { AgentRun, CreateFloorAgentInput, FloorAgent, FloorAgentSettingsPatch, FloorParticipant, FloorQueueItem } from "@/lib/floor-types";
import type { AgentLayout } from "./data";
import { agentTone, canRollbackRun } from "./data";
import { HoverTip, Icon, useHoverTip } from "./primitives";
import { Panel, type PanelChrome } from "./Rail";
import { AgentCard, AgentSpotlight } from "./AgentCard";
import type { RunActivitySource } from "./useRunActivity";
import { AgentChatHistory } from "./AgentChatHistory";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { AgentBulkControlsMenu } from "./AgentBulkControlsMenu";

function AgentRailItem({ agent, tone, selected, onSelect, railRef }: { agent: FloorAgent; tone: string; selected: boolean; onSelect: () => void; railRef: (id: string, element: HTMLButtonElement | null) => void }) {
  const tip = useHoverTip();
  return (
    <>
      <button
        type="button"
        ref={(element) => railRef(agent.id, element)}
        className="agent-rail-item"
        data-tone={tone}
        data-selected={selected ? "true" : "false"}
        role="tab"
        aria-selected={selected}
        aria-label={`${agent.name}${agent.kind ? ", auto-generated" : ""}`}
        onClick={onSelect}
        {...tip.handlers}
      >
        {agent.name.slice(0, 1)}
      </button>
      <HoverTip position={tip.position}>{agent.name}{agent.kind ? " · Auto-generated" : ""}</HoverTip>
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

export function AgentFloor({ chrome, sessionId, agents, runs, activity, selected, onSelect, agentLayout, onAgentLayout, onCreateAgent, onUpdateSettings, onRollback, onPauseAgent, onStopAgent, onDeleteAgent, onPauseAllAgents, onResumeAllAgents, onStopAllAgents, agentControlsBusy, queue, participants, currentUserId, enabledProviders, providerCredentials, owner, autoProvisionAgents, autoAgentProvider, effectiveAutoAgentProvider, autoAgentProviderState, onAutoProvisionAgents, onAutoAgentProvider }: {
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
  onUpdateSettings: (agentId: string, patch: FloorAgentSettingsPatch) => Promise<boolean>;
  onPauseAgent: (agentId: string, paused: boolean) => void;
  onStopAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onPauseAllAgents: () => Promise<void>;
  onResumeAllAgents: () => Promise<void>;
  onStopAllAgents: () => Promise<void>;
  agentControlsBusy: boolean;
  onRollback: (runId: string) => Promise<void>;
  queue: FloorQueueItem[];
  participants: FloorParticipant[];
  currentUserId: string;
  enabledProviders: CredentialProvider[];
  providerCredentials: ProviderCredentialSummary[];
  owner: boolean;
  autoProvisionAgents: boolean;
  autoAgentProvider: CredentialProvider | null;
  effectiveAutoAgentProvider: CredentialProvider | null;
  autoAgentProviderState: "selected" | "single_connected" | "openai_fallback" | "selection_required";
  onAutoProvisionAgents: (enabled: boolean) => Promise<boolean>;
  onAutoAgentProvider: (provider: CredentialProvider | null) => Promise<boolean>;
}) {
  const [creating, setCreating] = useState(false);
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const historyAgent = agents.find((agent) => agent.id === historyAgentId) ?? null;
  const providerOptions: SelectMenuOption[] = connectedProviders(providerCredentials, enabledProviders).map(
    (provider) => ({ value: provider, label: AGENT_PROVIDER_LABELS[provider] }),
  );
  if (providerOptions.length > 1) providerOptions.unshift({ value: "", label: "Choose provider" });
  const selectedLatestRun = selected ? runs.find((run) => run.agentId === selected.id) ?? null : null;

  function focusAgent(id: string) {
    onSelect(id);
    onAgentLayout("focus");
  }

  // FLIP: a newly added agent just appears at the rail's left edge; every
  // existing chip needs to visibly slide over to make room rather than jump.
  // Rects are read fresh each render into a ref (not state, so this never
  // itself triggers a render) — the layout effect below diffs this render's
  // positions against the ones read last time, before the DOM settles into
  // its final (already-shifted) layout, then plays the delta back as a
  // transform so .agent-rail-item's own transition animates it away.
  const railItemsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const prevRailRectsRef = useRef<Map<string, DOMRect> | null>(null);
  function registerRailItem(id: string, element: HTMLButtonElement | null) {
    if (element) railItemsRef.current.set(id, element);
    else railItemsRef.current.delete(id);
  }
  useLayoutEffect(() => {
    const prevRects = prevRailRectsRef.current;
    const nextRects = new Map<string, DOMRect>();
    railItemsRef.current.forEach((element, id) => {
      const next = element.getBoundingClientRect();
      nextRects.set(id, next);
      const prev = prevRects?.get(id);
      if (!prev) return;
      const dx = prev.left - next.left;
      if (!dx) return;
      element.style.transition = "none";
      element.style.transform = `translateX(${dx}px)`;
      element.getBoundingClientRect();
      requestAnimationFrame(() => {
        element.style.transition = "";
        element.style.transform = "";
      });
    });
    prevRailRectsRef.current = nextRects;
  }, [agents]);

  const headerActions = (
    <>
      {agents.length > 0 && (
        <div className="agent-header-rail" role="tablist" aria-label="Agents">
          {agents.map((agent, index) => (
            <AgentRailItem key={agent.id} agent={agent} tone={agentTone(agent.id, index)} selected={agentLayout === "focus" && selected?.id === agent.id} onSelect={() => focusAgent(agent.id)} railRef={registerRailItem} />
          ))}
        </div>
      )}
      {agents.length > 0 && <AllAgentsButton active={agentLayout === "all"} onClick={() => onAgentLayout("all")} />}
      {owner && agents.some((agent) => !agent.kind) && (
        <AgentBulkControlsMenu onPauseAll={onPauseAllAgents} onResumeAll={onResumeAllAgents} onStopAll={onStopAllAgents} busy={agentControlsBusy} />
      )}
      {owner && (
        <button type="button" className="chip auto-agent-toggle" data-selected={autoProvisionAgents ? "true" : "false"} aria-pressed={autoProvisionAgents} onClick={() => void onAutoProvisionAgents(!autoProvisionAgents)}>
          Auto agents {autoProvisionAgents ? "on" : "off"}
        </button>
      )}
      {owner && autoProvisionAgents && providerOptions.length > 0 && (
        <SelectMenu
          value={autoAgentProvider ?? effectiveAutoAgentProvider ?? ""}
          options={providerOptions}
          label="Default provider for auto-generated agents"
          onChange={(value) => void onAutoAgentProvider((value || null) as CredentialProvider | null)}
        />
      )}
      {owner && autoProvisionAgents && autoAgentProviderState === "openai_fallback" && <span className="auto-agent-note">No personal key · server OpenAI fallback</span>}
      {owner && autoProvisionAgents && autoAgentProviderState === "selection_required" && <span className="auto-agent-note" data-tone="attention">Choose a default provider</span>}
      <button ref={createButtonRef} type="button" className="chip chip-create" onClick={() => setCreating(true)}><Icon name="plus" size={11} />New agent</button>
    </>
  );

  return <>
    <Panel chrome={chrome} title="Agent floor" actions={headerActions}>
      {agents.length === 0 ? (
        <div className="floor-empty"><strong>No agents yet</strong><p>Create an agent when the session has work to assign.</p><button type="button" className="button" data-variant="primary" onClick={() => setCreating(true)}>Create agent</button></div>
      ) : agentLayout === "all" ? (
        <div className="agent-grid">{agents.map((agent, index) => { const latestRun = runs.find((run) => run.agentId === agent.id) ?? null; return <AgentCard key={agent.id} agent={agent} tone={agentTone(agent.id, index)} latestRun={latestRun} activityEvents={latestRun ? activity.eventsFor(latestRun.id) : []} selected={selected?.id === agent.id} owner={owner} onFocus={() => focusAgent(agent.id)} onHistory={() => setHistoryAgentId(agent.id)} onPause={onPauseAgent} onStop={onStopAgent} onDelete={onDeleteAgent} />; })}</div>
      ) : selected ? (
        <AgentSpotlight agent={selected} tone={agentTone(selected.id, agents.findIndex((agent) => agent.id === selected.id))} sessionId={sessionId} latestRun={selectedLatestRun} activity={activity} canRollback={canRollbackRun({ run: selectedLatestRun, item: queue.find((item) => item.id === selectedLatestRun?.queueItemId), agent: selected, currentUserId, sessionOwner: owner })} busy={agentControlsBusy} owner={owner} onRollback={onRollback} onHistory={() => setHistoryAgentId(selected.id)} onUpdateSettings={onUpdateSettings} onPause={onPauseAgent} onStop={onStopAgent} onDelete={onDeleteAgent} />
      ) : null}
    </Panel>
    {creating && <CreateAgentDialog sessionId={sessionId} participants={participants} currentUserId={currentUserId} enabledProviders={enabledProviders} providerCredentials={providerCredentials} onClose={() => { setCreating(false); createButtonRef.current?.focus(); }} onCreate={onCreateAgent} />}
    {historyAgent && <AgentChatHistory agent={historyAgent} queue={queue} onClose={() => setHistoryAgentId(null)} />}
  </>;
}

"use client";

import type { FloorAgent } from "@/lib/floor-types";

export function AgentTargetMenu({ value, onChange, agents }: { value: string | null; onChange: (id: string | null) => void; agents: FloorAgent[] }) {
  return <select className="agent-target" aria-label="Queue target" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}><option value="">Unassigned</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>;
}

"use client";

import type { FloorAgent } from "@/lib/floor-types";
import { SelectMenu } from "./SelectMenu";

export function AgentTargetMenu({ value, onChange, agents, allowAuto = true }: { value: string | null; onChange: (id: string | null) => void; agents: FloorAgent[]; allowAuto?: boolean }) {
  return (
    <SelectMenu
      label="Queue target"
      align="up"
      value={value ?? ""}
      onChange={(next) => onChange(next || null)}
      options={allowAuto ? [{ value: "", label: "Auto" }, ...agents.filter((agent) => agent.canUse !== false).map((agent) => ({ value: agent.id, label: agent.name }))] : agents.filter((agent) => agent.canUse !== false).map((agent) => ({ value: agent.id, label: agent.name }))}
    />
  );
}

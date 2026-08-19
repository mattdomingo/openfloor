"use client";

import type { FloorAgent } from "@/lib/floor-types";
import { SelectMenu } from "./SelectMenu";

export function AgentTargetMenu({ value, onChange, agents }: { value: string | null; onChange: (id: string | null) => void; agents: FloorAgent[] }) {
  return (
    <SelectMenu
      label="Queue target"
      align="up"
      value={value ?? ""}
      onChange={(next) => onChange(next || null)}
      options={[{ value: "", label: "Unassigned" }, ...agents.map((agent) => ({ value: agent.id, label: agent.name }))]}
    />
  );
}

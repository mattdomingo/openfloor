"use client";

import { useRequireMockUser } from "@/components/auth/useRequireMockUser";
import { Workspace } from "./Workspace";

export function SessionGate({ sessionTitle }: { sessionTitle: string }) {
  const user = useRequireMockUser();
  if (!user) return null;

  return <Workspace sessionTitle={sessionTitle} />;
}

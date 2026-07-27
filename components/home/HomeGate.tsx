"use client";

import { useRequireMockUser } from "@/components/auth/useRequireMockUser";
import { HomeScreen } from "./HomeScreen";

export function HomeGate() {
  const user = useRequireMockUser();
  if (!user) return null;

  return <HomeScreen user={user} />;
}

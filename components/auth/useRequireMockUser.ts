"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MockUser, getMockUser } from "./mockAuth";

/* Redirects to the landing page if nobody's "logged in" yet; otherwise returns the mock user. */
export function useRequireMockUser(): MockUser | null {
  const router = useRouter();
  const [user, setUser] = useState<MockUser | null>(null);

  useEffect(() => {
    const existing = getMockUser();
    if (!existing) {
      router.replace("/");
      return;
    }
    // localStorage isn't available during SSR, so this can only be read after mount —
    // starting from null and setting it here (rather than lazy useState init) keeps
    // the client's first render matching the server's and avoids a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUser(existing);
  }, [router]);

  return user;
}

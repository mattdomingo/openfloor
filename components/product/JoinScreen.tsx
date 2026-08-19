"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import type { InvitePreview } from "@/db/sessions";
import { Brand } from "./Brand";

export function JoinScreen({ token, preview, displayName }: { token: string; preview: InvitePreview; displayName: string }) {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setJoining(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
    const body = (await response.json()) as { sessionId?: string; error?: string };
    if (!response.ok || !body.sessionId) {
      setError(body.error ?? "This invite is no longer available.");
      setJoining(false);
      return;
    }
    router.replace(`/session/${body.sessionId}`);
  }

  return (
    <main className="join-shell">
      <Brand />
      <section className="join-card">
        <p className="eyebrow">Session invitation</p>
        <h1>{preview.title}</h1>
        <p className="join-objective">{preview.objective || "No objective has been written yet."}</p>
        <dl><div><dt>Host</dt><dd>{preview.ownerName}</dd></div><div><dt>Joining as</dt><dd>{displayName}</dd></div></dl>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button" data-variant="primary" data-size="lg" disabled={joining} onClick={join}>{joining ? "Joining…" : "Join session"}</button>
        <Link href="/home">Back to your sessions</Link>
      </section>
    </main>
  );
}

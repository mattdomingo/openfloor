"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import type { InvitePreview } from "@/db/sessions";
import { Brand } from "./Brand";

export function JoinScreen({ token, preview, displayName, alreadyMember }: {
  token: string;
  preview: InvitePreview;
  displayName: string;
  alreadyMember: boolean;
}) {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Advisory only — the 403 from actually accepting is the enforcement, in
  // case the owner's plan changed or another racer filled the last seat
  // between this render and the click. A returning member's re-accept is
  // idempotent past the cap, so this never applies to them.
  const full = !alreadyMember && preview.memberCount >= preview.seatLimit;
  // Same idempotency carve-out as full: locking only gates new joins, so an
  // existing member reloading this link must not see it as blocked.
  const locked = !alreadyMember && preview.locked;

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
        {locked && !error && <p className="form-error" role="alert">This session is locked. Ask the owner to unlock it.</p>}
        {full && !locked && !error && <p className="form-error" role="alert">This session is full ({preview.memberCount} of {preview.seatLimit} seats).</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button" data-variant="primary" data-size="lg" disabled={joining || full || locked} onClick={join}>{joining ? "Joining…" : locked ? "Session locked" : full ? "Session full" : "Join session"}</button>
        <Link href="/home">Back to your sessions</Link>
      </section>
    </main>
  );
}

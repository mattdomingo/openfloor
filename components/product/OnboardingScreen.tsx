"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { Avatar } from "@/components/session/primitives";
import { ACCEPTED_AVATAR_TYPE_LIST, ACCEPTED_AVATAR_TYPES, MAX_AVATAR_BYTES } from "@/lib/avatar-constraints";
import { initialsFromParts } from "@/lib/display-name";
import { PAID_PLAN_CATALOG, PLAN_LIMITS, planLimitsSummary, type PaidPlan } from "@/lib/plans";
import { Brand } from "./Brand";

function splitName(fullName: string | null): { firstName: string; lastName: string } {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export function OnboardingScreen({
  fullName, firstName: savedFirstName, lastName: savedLastName, githubHandle: savedGithubHandle, returnTo, inviteSignup,
}: {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  githubHandle: string | null;
  returnTo: string;
  inviteSignup: boolean;
}) {
  const router = useRouter();
  const initial = splitName(fullName);
  const [firstName, setFirstName] = useState(savedFirstName ?? initial.firstName);
  const [lastName, setLastName] = useState(savedLastName ?? initial.lastName);
  const [githubHandle, setGithubHandle] = useState(savedGithubHandle ?? "");
  const [plan, setPlan] = useState<"free" | PaidPlan | null>(inviteSignup ? "free" : null);
  const [quantity, setQuantity] = useState(3);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = firstName.trim().length > 0 && lastName.trim().length > 0 && plan != null;

  function choosePlan(next: "free" | PaidPlan) {
    setPlan(next);
    if (next !== "free") setQuantity((value) => Math.min(PAID_PLAN_CATALOG[next].maximumSeats, Math.max(PAID_PLAN_CATALOG[next].minimumSeats, value)));
  }

  function pickAvatar(file: File | undefined) {
    if (!file) return;
    if (!ACCEPTED_AVATAR_TYPES.has(file.type)) {
      setError("Profile pictures must be a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError("Profile pictures must be 5MB or smaller.");
      return;
    }
    setError(null);
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    const form = new FormData();
    form.set("firstName", firstName.trim());
    form.set("lastName", lastName.trim());
    form.set("githubHandle", githubHandle.trim());
    form.set("plan", plan ?? "");
    form.set("quantity", String(quantity));
    form.set("returnTo", returnTo);
    if (avatarFile) form.set("avatar", avatarFile);
    const response = await fetch(`${BASE_PATH}/api/account/onboarding`, { method: "POST", body: form });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Unable to save your account. Try again.");
      setSubmitting(false);
      return;
    }
    const body = await response.json() as { url: string };
    const destination = new URL(body.url, window.location.origin);
    if (destination.origin !== window.location.origin) {
      window.location.assign(destination.toString());
      return;
    }
    const barePath = BASE_PATH && destination.pathname.startsWith(BASE_PATH)
      ? destination.pathname.slice(BASE_PATH.length) || "/"
      : destination.pathname;
    router.replace(`${barePath}${destination.search}${destination.hash}`);
  }

  return (
    <main className="join-shell">
      <Brand />
      <section className="join-card">
        <p className="eyebrow">Welcome</p>
        <h1>Set up your account</h1>
        <p className="join-objective">Tell the room who you are. You can always come back and change this later.</p>

        <form className="create-card" onSubmit={submit}>
          <label className="field">
            <span className="label">Profile picture <em>optional</em></span>
            <div className="onboarding-avatar-picker">
              <Avatar initials={initialsFromParts(firstName, lastName)} tone="you" previewSrc={avatarPreview ?? undefined} />
              <input type="file" accept={ACCEPTED_AVATAR_TYPE_LIST.join(",")} onChange={(event) => pickAvatar(event.target.files?.[0])} />
            </div>
          </label>

          <div className="field-grid">
            <label className="field"><span className="label">First name</span><input value={firstName} onChange={(event) => setFirstName(event.target.value)} maxLength={50} required autoFocus /></label>
            <label className="field"><span className="label">Last name</span><input value={lastName} onChange={(event) => setLastName(event.target.value)} maxLength={50} required /></label>
          </div>

          <label className="field"><span className="label">GitHub handle <em>optional</em></span><input value={githubHandle} onChange={(event) => setGithubHandle(event.target.value)} maxLength={39} placeholder="octocat" /></label>

          {inviteSignup ? (
            <p className="notice" role="status">This invite includes a Free openfloor account. You can upgrade later from Settings.</p>
          ) : (
            <fieldset className="plan-picker">
              <legend>Choose your plan</legend>
              <button type="button" className="plan-card" aria-pressed={plan === "free"} onClick={() => choosePlan("free")}>
                <strong>Free</strong><span>$0</span><small>{planLimitsSummary("free")}</small>
              </button>
              {(["pro", "max"] as const).map((paidPlan) => {
                const catalog = PAID_PLAN_CATALOG[paidPlan];
                const selected = plan === paidPlan;
                return (
                  <button type="button" className="plan-card" aria-pressed={selected} onClick={() => choosePlan(paidPlan)} key={paidPlan}>
                    <strong>{paidPlan === "pro" ? "Pro" : "Max"}</strong>
                    <span>${catalog.unitAmountCents / 100}/seat/month</span>
                    <small>{`${catalog.minimumSeats}–${catalog.maximumSeats} seats per session, ${PLAN_LIMITS[paidPlan].hours}h per month`}</small>
                  </button>
                );
              })}
              <a className="plan-card" href="mailto:hello@opnflr.com">
                <strong>Enterprise</strong><span>Contact sales</span><small>{planLimitsSummary("enterprise")}</small>
              </a>
              {plan && plan !== "free" && (
                <div className="seat-picker">
                  <span>{`Seats per session: ${quantity}`}</span>
                  <button type="button" className="button" data-variant="quiet" disabled={quantity <= PAID_PLAN_CATALOG[plan].minimumSeats} onClick={() => setQuantity((value) => value - 1)} aria-label="Remove one seat">−</button>
                  <button type="button" className="button" data-variant="quiet" disabled={quantity >= PAID_PLAN_CATALOG[plan].maximumSeats} onClick={() => setQuantity((value) => value + 1)} aria-label="Add one seat">+</button>
                </div>
              )}
            </fieldset>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions"><button className="button" data-variant="primary" data-size="lg" disabled={!ready || submitting}>{submitting ? "Saving…" : plan === "free" ? "Continue with Free" : "Continue to payment"}</button></div>
        </form>
      </section>
    </main>
  );
}

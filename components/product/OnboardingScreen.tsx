"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WaveField } from "@/app/entry-wave";
import { BASE_PATH } from "@/components/basePath";
import { Avatar } from "@/components/session/primitives";
import { ACCEPTED_AVATAR_TYPE_LIST, ACCEPTED_AVATAR_TYPES, MAX_AVATAR_BYTES } from "@/lib/avatar-constraints";
import { initialsFromParts } from "@/lib/display-name";
import { PAID_PLAN_CATALOG, PLAN_LIMITS, planLimitsSummary, type PaidPlan } from "@/lib/plans";
import { Brand } from "./Brand";

type OnboardingPlan = "free" | PaidPlan;
type OnboardingStep = 1 | 2;

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
  const [step, setStep] = useState<OnboardingStep>(1);
  const [firstName, setFirstName] = useState(savedFirstName ?? initial.firstName);
  const [lastName, setLastName] = useState(savedLastName ?? initial.lastName);
  const [githubHandle, setGithubHandle] = useState(savedGithubHandle ?? "");
  const [plan, setPlan] = useState<OnboardingPlan | null>(inviteSignup ? "free" : null);
  const [quantity, setQuantity] = useState(3);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const profileHeadingRef = useRef<HTMLHeadingElement>(null);
  const planHeadingRef = useRef<HTMLHeadingElement>(null);
  const validProfile = firstName.trim().length > 0 && lastName.trim().length > 0;
  const ready = validProfile && plan != null;

  useEffect(() => {
    (step === 1 ? profileHeadingRef : planHeadingRef).current?.focus();
  }, [step]);

  useEffect(() => () => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  }, [avatarPreview]);

  function choosePlan(next: OnboardingPlan) {
    setPlan(next);
    setSubmitError(null);
    if (next !== "free") {
      setQuantity((value) => Math.min(PAID_PLAN_CATALOG[next].maximumSeats, Math.max(PAID_PLAN_CATALOG[next].minimumSeats, value)));
    }
  }

  function pickAvatar(file: File | undefined) {
    if (!file) return;
    if (!ACCEPTED_AVATAR_TYPES.has(file.type)) {
      setProfileError("Profile pictures must be a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setProfileError("Profile pictures must be 5MB or smaller.");
      return;
    }
    setProfileError(null);
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  function continueToPlan() {
    if (!validProfile) {
      setProfileError("Enter your first and last name to continue.");
      return;
    }
    setProfileError(null);
    setStep(2);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step === 1) {
      continueToPlan();
      return;
    }
    if (!ready || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
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
      setSubmitError(body?.error ?? "Unable to save your account. Try again.");
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
    <main className="product-shell shop-shell onboarding-shell">
      <WaveField varName="--wave" className="shop-wave" />
      <header className="app-header"><Brand /></header>
      <div className="onboarding-stage">
        <section className="onboarding-card" aria-labelledby="onboarding-title">
          <div className="onboarding-intro">
            <p className="eyebrow">Welcome to openfloor</p>
            <h1 id="onboarding-title">Set up your account</h1>
            <p>Your profile introduces you to the room. Your plan sets the capacity for sessions you own.</p>
          </div>

          <ol className="onboarding-progress" aria-label="Account setup progress">
            <li aria-current={step === 1 ? "step" : undefined} data-complete={step > 1}>
              <span>01</span><strong>Profile</strong>
            </li>
            <li aria-current={step === 2 ? "step" : undefined}>
              <span>02</span><strong>Plan</strong>
            </li>
          </ol>

          <form className="onboarding-form" onSubmit={submit} noValidate>
            <section className="onboarding-step" hidden={step !== 1} aria-labelledby="profile-step-title">
              <div className="onboarding-step-heading">
                <p className="eyebrow">Step 1 of 2</p>
                <h2 id="profile-step-title" ref={profileHeadingRef} tabIndex={-1}>Create your profile</h2>
                <p>Use the name your teammates will recognize. You can update these details later in Settings.</p>
              </div>

              <label className="field onboarding-avatar-field">
                <span className="label">Profile picture <em>optional</em></span>
                <div className="onboarding-avatar-picker">
                  <Avatar initials={initialsFromParts(firstName, lastName)} tone="you" previewSrc={avatarPreview ?? undefined} />
                  <div><input type="file" accept={ACCEPTED_AVATAR_TYPE_LIST.join(",")} onChange={(event) => pickAvatar(event.target.files?.[0])} /><small>PNG, JPEG, or WebP. 5MB maximum.</small></div>
                </div>
              </label>

              <div className="field-grid">
                <label className="field"><span className="label">First name</span><input value={firstName} onChange={(event) => { setFirstName(event.target.value); setProfileError(null); }} maxLength={50} required autoComplete="given-name" /></label>
                <label className="field"><span className="label">Last name</span><input value={lastName} onChange={(event) => { setLastName(event.target.value); setProfileError(null); }} maxLength={50} required autoComplete="family-name" /></label>
              </div>

              <label className="field"><span className="label">GitHub handle <em>optional</em></span><input value={githubHandle} onChange={(event) => setGithubHandle(event.target.value)} maxLength={39} placeholder="octocat" autoComplete="off" /></label>

              {profileError && <p className="form-error" role="alert">{profileError}</p>}
              <div className="form-actions"><button type="submit" className="button" data-variant="primary" data-size="lg">Continue</button></div>
            </section>

            <section className="onboarding-step" hidden={step !== 2} aria-labelledby="plan-step-title">
              <div className="onboarding-step-heading">
                <p className="eyebrow">Step 2 of 2</p>
                <h2 id="plan-step-title" ref={planHeadingRef} tabIndex={-1}>{inviteSignup ? "Your invite includes Free" : "Choose your plan"}</h2>
                <p>{inviteSignup ? "Finish your profile now, then review the session invite before you join." : "Pick the capacity that fits your work."}</p>
              </div>

              {inviteSignup ? (
                <div className="onboarding-invite-plan" role="status">
                  <div><strong>Free</strong><span>$0</span><small>{planLimitsSummary("free")}</small></div>
                  <p>This invite includes a Free openfloor account. You can upgrade later from Settings.</p>
                </div>
              ) : (
                <fieldset className="plan-picker">
                  <legend className="sr-only">Choose your plan</legend>
                  <button type="button" className="plan-card" aria-pressed={plan === "free"} onClick={() => choosePlan("free")}>
                    <strong>Free</strong><span>$0</span><small>{planLimitsSummary("free")}</small>
                  </button>
                  {(["pro", "max"] as const).map((paidPlan) => {
                    const catalog = PAID_PLAN_CATALOG[paidPlan];
                    return (
                      <button type="button" className="plan-card" aria-pressed={plan === paidPlan} onClick={() => choosePlan(paidPlan)} key={paidPlan}>
                        <strong>{paidPlan === "pro" ? "Pro" : "Max"}</strong>
                        <span>${catalog.unitAmountCents / 100}/seat/month</span>
                        <small>{`${catalog.minimumSeats}–${catalog.maximumSeats} seats per session, ${PLAN_LIMITS[paidPlan].hours}h per month`}</small>
                      </button>
                    );
                  })}
                  <a className="plan-card plan-card-enterprise" href="mailto:hello@opnflr.com">
                    <strong>Enterprise</strong><span>Contact sales</span><small>{planLimitsSummary("enterprise")}</small>
                  </a>
                  {plan && plan !== "free" && (
                    <div className="seat-picker">
                      <span>{`Seats per session: ${quantity}`}</span>
                      <div>
                        <button type="button" className="button" data-variant="quiet" disabled={quantity <= PAID_PLAN_CATALOG[plan].minimumSeats} onClick={() => setQuantity((value) => value - 1)} aria-label="Remove one seat">−</button>
                        <button type="button" className="button" data-variant="quiet" disabled={quantity >= PAID_PLAN_CATALOG[plan].maximumSeats} onClick={() => setQuantity((value) => value + 1)} aria-label="Add one seat">+</button>
                      </div>
                    </div>
                  )}
                </fieldset>
              )}

              {submitError && <p className="form-error" role="alert">{submitError}</p>}
              <div className="form-actions onboarding-plan-actions">
                <button type="button" className="button" data-variant="quiet" disabled={submitting} onClick={() => setStep(1)}>Back</button>
                <button type="submit" className="button" data-variant="primary" data-size="lg" disabled={!ready || submitting}>{submitting ? "Saving…" : plan === "free" ? "Finish setup" : "Continue to payment"}</button>
              </div>
            </section>
          </form>
        </section>
      </div>
    </main>
  );
}

"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { WaveField } from "@/app/entry-wave";
import { BASE_PATH } from "@/components/basePath";
import { AvatarCropper, AvatarFileButton } from "@/components/product/AvatarCropper";
import { Avatar, Spinner } from "@/components/session/primitives";
import { ACCEPTED_AVATAR_TYPES, MAX_AVATAR_BYTES } from "@/lib/avatar-constraints";
import { initialsFromParts, repoCountLabel } from "@/lib/display-name";
import { CREDENTIAL_PROVIDERS, type ProviderCredentialSummary } from "@/lib/provider-credentials";
import type { OnboardingStep } from "@/lib/onboarding-plan";
import { Brand } from "./Brand";
import { ProviderCredentials } from "./ProviderCredentials";
import { GitHubDeviceDialog } from "@/components/product/GitHubDeviceDialog";
import type { UserGitHubInstallationSummary } from "@/lib/session-types";

function splitName(fullName: string | null): { firstName: string; lastName: string } {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

// Two steps: profile + GitHub access together, then AI connections. The plan
// step is hidden for now — everyone is enrolled on Free (the submit always
// posts plan=free; lib/onboarding-plan.ts carries the same note).
export function OnboardingScreen({
  fullName, firstName: savedFirstName, lastName: savedLastName, githubHandle: savedGithubHandle, returnTo,
  githubInstallations: initialGithubInstallations, initialCredentials, initialStep,
}: {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  githubHandle: string | null;
  returnTo: string;
  githubInstallations: UserGitHubInstallationSummary[];
  initialCredentials: ProviderCredentialSummary[];
  initialStep: OnboardingStep | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const initial = splitName(fullName);
  const [step, setStep] = useState<OnboardingStep>(initialStep ?? 1);

  // Every step change replaces `step` in the URL so a refresh — or the one
  // someone reaches for when a provider-key "Connect" looks stuck — lands
  // back on the step it was taken from, not always step 1.
  function changeStep(next: OnboardingStep) {
    setStep(next);
    const params = new URLSearchParams(window.location.search);
    params.set("step", String(next));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }
  const [firstName, setFirstName] = useState(savedFirstName ?? initial.firstName);
  const [lastName, setLastName] = useState(savedLastName ?? initial.lastName);
  const githubHandle = savedGithubHandle ?? "";
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [cropSource, setCropSource] = useState<File | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [githubInstallations, setGithubInstallations] = useState(initialGithubInstallations);
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);
  const profileHeadingRef = useRef<HTMLHeadingElement>(null);
  const connectionsHeadingRef = useRef<HTMLHeadingElement>(null);
  const stepHeadingRefs = { 1: profileHeadingRef, 2: connectionsHeadingRef };
  const validProfile = firstName.trim().length > 0 && lastName.trim().length > 0;
  const githubReady = githubInstallations.some((installation) => installation.status === "active");
  const ready = validProfile && githubReady;

  useEffect(() => {
    stepHeadingRefs[step].current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => () => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  }, [avatarPreview]);

  // Returning from the App-install redirect: that path can't verify which
  // repos this member can reach (no user token), so the link landed with an
  // empty scope — reopen the device dialog to capture the real one.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("github") !== "connected") return;
    params.delete("github");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    setDeviceDialogOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setCropSource(file);
  }

  // The cropper hands back the framed square, so what is previewed here is
  // exactly what gets uploaded.
  function applyCrop(cropped: File) {
    setCropSource(null);
    setAvatarFile(cropped);
    setAvatarPreview(URL.createObjectURL(cropped));
  }

  async function continueToConnections() {
    if (!validProfile) {
      setProfileError("Enter your first and last name to continue.");
      return;
    }
    if (!githubReady) {
      setProfileError("Connect GitHub to continue.");
      return;
    }
    setProfileError(null);
    setSubmitting(true);
    const form = new FormData();
    form.set("firstName", firstName.trim());
    form.set("lastName", lastName.trim());
    form.set("githubHandle", githubHandle.trim());
    if (avatarFile) form.set("avatar", avatarFile);
    const response = await fetch(`${BASE_PATH}/api/account/onboarding`, { method: "PATCH", body: form });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setProfileError(body?.error ?? "Unable to save your profile. Try again.");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    changeStep(2);
  }

  function connectGitHub() {
    setProfileError(null);
    setDeviceDialogOpen(true);
  }

  // GitHub authorization already names the person; only fill fields the user
  // hasn't typed in, and fall back to the login when no display name is set.
  function prefillNameFromGitHub(githubUser: { login: string; name: string | null }) {
    if (firstName.trim() || lastName.trim()) return;
    const parts = splitName(githubUser.name ?? githubUser.login);
    setFirstName(parts.firstName);
    setLastName(parts.lastName);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void continueToConnections();
  }

  async function finishSetup() {
    if (!ready || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const form = new FormData();
    form.set("firstName", firstName.trim());
    form.set("lastName", lastName.trim());
    form.set("githubHandle", githubHandle.trim());
    form.set("plan", "free");
    form.set("returnTo", returnTo);
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
            <p>Your profile introduces you to the room. GitHub supplies repository access. AI connections power your agents.</p>
          </div>

          <ol className="onboarding-progress" aria-label="Account setup progress">
            <li aria-current={step === 1 ? "step" : undefined} data-complete={step > 1}>
              <span>01</span><strong>Profile &amp; GitHub</strong>
            </li>
            <li aria-current={step === 2 ? "step" : undefined}>
              <span>02</span><strong>AI connections</strong>
            </li>
          </ol>

          {/* No shared wrapping form: ProviderCredentials in step 2 has its own
              forms, and nesting them breaks credential saves during onboarding. */}
          <div className="onboarding-form">
            <form className="onboarding-step" onSubmit={submit} noValidate hidden={step !== 1} aria-labelledby="profile-step-title">
              <div className="onboarding-step-heading">
                <p className="eyebrow">Step 1 of 2</p>
                <h2 id="profile-step-title" ref={profileHeadingRef} tabIndex={-1}>Create your profile</h2>
                <p>Use the name your teammates will recognize. You can update these details later in Settings.</p>
              </div>

              <div className="field onboarding-avatar-field">
                <span className="label">Profile picture <em>optional</em></span>
                <div className="onboarding-avatar-picker">
                  {/* The tile is what people click first, so it drives the same
                      file input as the button — natively, via the label. */}
                  <label htmlFor="onboarding-avatar-input" className="onboarding-avatar-tile" aria-label="Choose profile picture">
                    <Avatar initials={initialsFromParts(firstName, lastName)} tone="you" previewSrc={avatarPreview ?? undefined} />
                  </label>
                  <div><AvatarFileButton hasPicture={Boolean(avatarPreview)} onPick={pickAvatar} inputId="onboarding-avatar-input" /><small>PNG, JPEG, or WebP. 5MB maximum.</small></div>
                </div>
              </div>
              {cropSource && <AvatarCropper file={cropSource} onCancel={() => setCropSource(null)} onCropped={applyCrop} />}

              <div className="field-grid">
                <label className="field"><span className="label">First name</span><input value={firstName} onChange={(event) => { setFirstName(event.target.value); setProfileError(null); }} maxLength={50} required autoComplete="given-name" /></label>
                <label className="field"><span className="label">Last name</span><input value={lastName} onChange={(event) => { setLastName(event.target.value); setProfileError(null); }} maxLength={50} required autoComplete="family-name" /></label>
              </div>

              <div className="field">
                <span className="label">GitHub access</span>
                {githubReady ? (
                  <div className="onboarding-invite-plan" role="status">
                    {githubInstallations.filter((installation) => installation.status === "active").map((installation) => (
                      <div key={installation.id}><strong>{installation.accountLogin}</strong><span>{[installation.accountType, repoCountLabel(installation.repoCount)].filter(Boolean).join(" · ")}</span></div>
                    ))}
                    <p>GitHub access connected. More installations can be added later from Settings.</p>
                  </div>
                ) : (
                  <>
                    <p className="form-note">Install openfloor GitHub App for each personal account or organization whose repositories you want to use. GitHub access is required before account setup can finish.</p>
                    {/* Wrapped so the field's grid doesn't stretch the button full-width. */}
                    <div><button type="button" className="button" data-variant="primary" disabled={submitting} onClick={connectGitHub}>Connect GitHub</button></div>
                  </>
                )}
              </div>
              {deviceDialogOpen && <GitHubDeviceDialog purpose="onboarding" returnTo={returnTo} onConnected={setGithubInstallations} onIdentity={prefillNameFromGitHub} onClose={() => setDeviceDialogOpen(false)} />}

              {profileError && <p className="form-error" role="alert">{profileError}</p>}
              <div className="form-actions"><button type="submit" className="button" data-variant="primary" data-size="lg" disabled={submitting}>{submitting ? "Saving…" : "Continue"}</button></div>
            </form>

            <section className="onboarding-step" hidden={step !== 2} aria-labelledby="connections-step-title">
              <div className="onboarding-step-heading">
                <p className="eyebrow">Step 2 of 2</p>
                <h2 id="connections-step-title" ref={connectionsHeadingRef} tabIndex={-1}>Connect AI providers</h2>
                <p>Optional. Connect the model provider keys you want to run agents with. You can add or change these anytime in Settings.</p>
              </div>
              <ProviderCredentials initialCredentials={initialCredentials} providers={[...CREDENTIAL_PROVIDERS]} />
              {submitError && <p className="form-error" role="alert">{submitError}</p>}
              <div className="form-actions onboarding-plan-actions">
                <button type="button" className="button" data-variant="quiet" disabled={submitting} onClick={() => changeStep(1)}>Back</button>
                <button type="button" className="button" data-variant="primary" data-size="lg" disabled={!ready || submitting} onClick={() => void finishSetup()}>{submitting ? <><Spinner />Saving…</> : "Finish setup"}</button>
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

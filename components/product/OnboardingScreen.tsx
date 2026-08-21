"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { Avatar } from "@/components/session/primitives";
import { ACCEPTED_AVATAR_TYPE_LIST, ACCEPTED_AVATAR_TYPES, MAX_AVATAR_BYTES } from "@/lib/avatar-constraints";
import { initialsFromParts } from "@/lib/display-name";
import { Brand } from "./Brand";

function splitName(fullName: string | null): { firstName: string; lastName: string } {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export function OnboardingScreen({ fullName, returnTo }: { fullName: string | null; returnTo: string }) {
  const router = useRouter();
  const initial = splitName(fullName);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [githubHandle, setGithubHandle] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = firstName.trim().length > 0 && lastName.trim().length > 0;

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
    if (avatarFile) form.set("avatar", avatarFile);
    const response = await fetch(`${BASE_PATH}/api/account/onboarding`, { method: "POST", body: form });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Unable to save your account. Try again.");
      setSubmitting(false);
      return;
    }
    // returnTo carries the BASE_PATH prefix (it round-trips through a query
    // param that must match real URLs), but next/navigation's router already
    // applies basePath itself, so pass it a bare path or it doubles up.
    const bareReturnTo = BASE_PATH && returnTo.startsWith(BASE_PATH) ? returnTo.slice(BASE_PATH.length) || "/" : returnTo;
    router.replace(bareReturnTo);
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

          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions"><button className="button" data-variant="primary" data-size="lg" disabled={!ready || submitting}>{submitting ? "Saving…" : "Continue"}</button></div>
        </form>
      </section>
    </main>
  );
}

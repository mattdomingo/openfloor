"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { DoNotDisturbToggle } from "@/components/DoNotDisturbToggle";
import { Avatar, SegmentedControl, useDialogDismiss } from "@/components/session/primitives";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ACCEPTED_AVATAR_TYPE_LIST, ACCEPTED_AVATAR_TYPES, MAX_AVATAR_BYTES } from "@/lib/avatar-constraints";
import { formatDuration } from "@/lib/date-format";
import { initialsFromParts } from "@/lib/display-name";
import { planLabel, planLimitsSummary, UPGRADE_URL, type Plan, type PlanStatus } from "@/lib/plans";
import type { AppUser } from "@/lib/session-types";
import { AppHeader } from "./AppHeader";

type SettingsSection = "profile" | "plan" | "preferences" | "danger";
type Usage = { plan: Plan; planStatus: PlanStatus; effectivePlan: Plan; seconds: number; limitHours: number; limitSeats: number };
type BlockedSession = { id: string; title: string; reason: "repository_state" | "integration_in_progress" };

export function SettingsScreen({ user: initialUser, usage }: { user: AppUser; usage: Usage }) {
  const [user, setUser] = useState(initialUser);
  // Same render-time resync idiom as HomeScreen: router.refresh() re-renders
  // this Server Component prop without remounting SettingsScreen.
  const [syncedUser, setSyncedUser] = useState(initialUser);
  if (syncedUser !== initialUser) {
    setSyncedUser(initialUser);
    setUser(initialUser);
  }
  const [section, setSection] = useState<SettingsSection>("profile");

  return (
    <main className="product-shell">
      <AppHeader user={user} />
      <section className="page-body">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Account</p>
            <h1>Settings</h1>
            <p>Your profile, plan, and preferences.</p>
          </div>
        </div>

        <SegmentedControl
          label="Settings section"
          value={section}
          onChange={setSection}
          options={[
            { value: "profile", label: "Profile" },
            { value: "plan", label: "Plan & usage" },
            { value: "preferences", label: "Preferences" },
            { value: "danger", label: "Danger zone" },
          ]}
        />

        {section === "profile" && <ProfileSection user={user} onSaved={setUser} />}
        {section === "plan" && <PlanSection usage={usage} />}
        {section === "preferences" && <PreferencesSection user={user} />}
        {section === "danger" && <DangerZoneSection />}
      </section>
    </main>
  );
}

function ProfileSection({ user, onSaved }: { user: AppUser; onSaved: (user: AppUser) => void }) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [githubHandle, setGithubHandle] = useState(user.githubHandle ?? "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const ready = firstName.trim().length > 0 && lastName.trim().length > 0;
  const showRemove = removeAvatar ? false : avatarPreview ? false : user.avatarKey != null;

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
    setSaved(false);
    setRemoveAvatar(false);
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  function pickRemoveAvatar() {
    setError(null);
    setSaved(false);
    setAvatarFile(null);
    setAvatarPreview(null);
    setRemoveAvatar(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    setSaved(false);
    const form = new FormData();
    form.set("firstName", firstName.trim());
    form.set("lastName", lastName.trim());
    form.set("githubHandle", githubHandle.trim());
    if (avatarFile) form.set("avatar", avatarFile);
    if (removeAvatar) form.set("removeAvatar", "true");
    const response = await fetch(`${BASE_PATH}/api/account/profile`, { method: "PATCH", body: form });
    const body = (await response.json().catch(() => null)) as { user?: AppUser; error?: string } | null;
    if (!response.ok || !body?.user) {
      setError(body?.error ?? "Unable to save your profile. Try again.");
      setSubmitting(false);
      return;
    }
    setAvatarFile(null);
    setAvatarPreview(null);
    setRemoveAvatar(false);
    setSaved(true);
    setSubmitting(false);
    onSaved(body.user);
    router.refresh();
  }

  return (
    <>
      <form className="create-card" onSubmit={submit}>
        <label className="field">
          <span className="label">Profile picture <em>optional</em></span>
          <div className="onboarding-avatar-picker">
            <Avatar
              userId={removeAvatar ? undefined : user.id}
              version={user.updatedAt}
              initials={initialsFromParts(firstName, lastName)}
              tone="you"
              previewSrc={avatarPreview ?? undefined}
            />
            <input type="file" accept={ACCEPTED_AVATAR_TYPE_LIST.join(",")} onChange={(event) => pickAvatar(event.target.files?.[0])} />
            {showRemove && (
              <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={pickRemoveAvatar}>Remove picture</button>
            )}
          </div>
        </label>

        <div className="field-grid">
          <label className="field"><span className="label">First name</span><input value={firstName} onChange={(event) => setFirstName(event.target.value)} maxLength={50} required /></label>
          <label className="field"><span className="label">Last name</span><input value={lastName} onChange={(event) => setLastName(event.target.value)} maxLength={50} required /></label>
        </div>

        <label className="field"><span className="label">GitHub handle <em>optional</em></span><input value={githubHandle} onChange={(event) => setGithubHandle(event.target.value)} maxLength={39} placeholder="octocat" /></label>

        {error && <p className="form-error" role="alert">{error}</p>}
        {saved && !error && <p className="notice" role="status">Saved.</p>}
        <div className="form-actions"><button className="button" data-variant="primary" disabled={!ready || submitting}>{submitting ? "Saving…" : "Save changes"}</button></div>
      </form>

      <ul className="settings-category-list">
        <li className="settings-category-row">
          <span className="settings-category-name">Email</span>
          <span className="settings-category-detail">
            <strong>{user.email}</strong><br />
            Managed by your sign-in provider. To use a different address, sign in with that account.
          </span>
        </li>
      </ul>
    </>
  );
}

function PlanSection({ usage }: { usage: Usage }) {
  const limitSeconds = usage.limitHours * 3600;
  const limitedHours = Number.isFinite(usage.limitHours);
  const limitedSeats = Number.isFinite(usage.limitSeats);

  return (
    <ul className="settings-category-list">
      <li className="settings-category-row">
        <span className="settings-category-name">Plan</span>
        <span className="settings-category-detail">{planLabel(usage.effectivePlan)} plan — {planLimitsSummary(usage.effectivePlan)}.</span>
        {usage.effectivePlan === "free" && (
          <a className="button" data-variant="quiet" href={UPGRADE_URL} target="_blank" rel="noreferrer noopener">Upgrade</a>
        )}
      </li>

      {(usage.planStatus === "past_due" || usage.planStatus === "canceled") && (
        <li className="settings-category-row">
          <span className="settings-category-name">Billing status</span>
          <span className="settings-category-detail">
            {`Your ${planLabel(usage.plan)} plan is ${usage.planStatus === "past_due" ? "past due" : "canceled"} — Free plan limits apply until it's resolved.`}
          </span>
        </li>
      )}

      <li className="settings-category-row">
        <span className="settings-category-name">Session time this month</span>
        <span className="settings-category-detail">
          {limitedHours ? (
            <progress className="usage-meter" value={usage.seconds} max={limitSeconds} aria-label={`${formatDuration(usage.seconds)} of ${usage.limitHours}h used this month`} />
          ) : null}
          {limitedHours
            ? `${formatDuration(usage.seconds)} of ${usage.limitHours}h used this month (UTC)`
            : `${formatDuration(usage.seconds)} used this month (UTC) · unlimited`}
        </span>
      </li>

      <li className="settings-category-row">
        <span className="settings-category-name">Seats</span>
        <span className="settings-category-detail">{limitedSeats ? `${usage.limitSeats} seats per session` : "Unlimited seats per session"}</span>
      </li>

      {usage.effectivePlan === "free" && (
        <li className="settings-category-row">
          <span className="settings-category-name">Upgrades</span>
          <span className="settings-category-detail">Upgrades are activated manually today — it can take a little while after you pay.</span>
        </li>
      )}
    </ul>
  );
}

function PreferencesSection({ user }: { user: AppUser }) {
  return (
    <ul className="settings-category-list">
      <li className="settings-category-row">
        <span className="settings-category-name">Notifications</span>
        <span className="settings-category-detail">Do Not Disturb mutes the team chat unread badge everywhere, on every device.</span>
        <DoNotDisturbToggle initialValue={user.doNotDisturb} />
      </li>
      <li className="settings-category-row">
        <span className="settings-category-name">Theme</span>
        <span className="settings-category-detail">A per-device preference — it doesn&apos;t follow you to other browsers or devices.</span>
        <ThemeToggle />
      </li>
    </ul>
  );
}

function DangerZoneSection() {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <ul className="settings-category-list">
        <li className="settings-category-row">
          <span className="settings-category-name">Delete account</span>
          <span className="settings-category-detail">Permanently deletes your account, your owned sessions, and your profile picture. This cannot be undone.</span>
          <button type="button" className="button danger-button" onClick={() => setConfirming(true)}>Delete account</button>
        </li>
      </ul>
      {confirming && <DeleteAccountDialog onClose={() => setConfirming(false)} />}
    </>
  );
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedSessions, setBlockedSessions] = useState<BlockedSession[] | null>(null);
  const ready = confirmText.trim() === "DELETE";

  async function remove() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setBlockedSessions(null);
    const response = await fetch(`${BASE_PATH}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; sessions?: BlockedSession[] } | null;
      setError(body?.error ?? "Unable to delete your account.");
      setBlockedSessions(body?.sessions ?? null);
      setBusy(false);
      return;
    }
    // Leaves the app entirely — not a router navigation.
    window.location.assign("/cdn-cgi/access/logout");
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="delete-account-title">
      <div className="dialog-head">
        <div className="dialog-title">
          <h2 id="delete-account-title">Delete your account?</h2>
          <p>
            Your owned sessions are permanently deleted, you&rsquo;re removed from every session you joined, and your profile and
            picture are erased. Messages you wrote elsewhere show as &ldquo;Deleted user.&rdquo; This cannot be undone.
          </p>
        </div>
      </div>
      <div className="dialog-body">
        {error && <p className="form-error" role="alert">{error}</p>}
        {blockedSessions && blockedSessions.length > 0 ? (
          <ul className="settings-category-list">
            {blockedSessions.map((session) => (
              <li key={session.id} className="settings-category-row">
                <span className="settings-category-name">{session.title}</span>
                <span className="settings-category-detail">
                  {session.reason === "integration_in_progress"
                    ? "A run is still integrating into this session's candidate branch."
                    : "This session's candidate branch hasn't merged yet — merge or abandon it first."}
                </span>
                <Link className="button" data-variant="quiet" data-size="sm" href={`/session/${session.id}`}>Open</Link>
              </li>
            ))}
          </ul>
        ) : (
          <label className="field"><span className="label">Type DELETE to confirm</span><input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoFocus /></label>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        {!(blockedSessions && blockedSessions.length > 0) && (
          <button type="button" className="button danger-button" onClick={remove} disabled={!ready || busy}>{busy ? "Deleting…" : "Delete account"}</button>
        )}
      </div>
    </dialog>
  );
}

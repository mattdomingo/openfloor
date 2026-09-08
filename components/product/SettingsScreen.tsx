"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AvatarCropper, AvatarFileButton } from "@/components/product/AvatarCropper";
import { BASE_PATH } from "@/components/basePath";
import { GitHubDeviceDialog } from "@/components/product/GitHubDeviceDialog";
import { DoNotDisturbToggle } from "@/components/DoNotDisturbToggle";
import { Avatar, Spinner, useDialogDismiss } from "@/components/session/primitives";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ACCEPTED_AVATAR_TYPES, MAX_AVATAR_BYTES } from "@/lib/avatar-constraints";
import { formatDuration } from "@/lib/date-format";
import { LocalDateTime } from "@/components/LocalDateTime";
import { initialsFromParts, repoCountLabel } from "@/lib/display-name";
import { lowHoursRemaining, PAID_PLAN_CATALOG, planLabel, planLimitsSummary, type PaidPlan, type Plan, type PlanStatus } from "@/lib/plans";
import {
  type CredentialProvider,
  monthlyUsageLabel,
  type MonthlyProviderUsage,
  type ProviderCredentialSummary,
} from "@/lib/provider-credentials";
import { formatTokens } from "@/components/session/data";
import type { AppUser, UserGitHubInstallationSummary } from "@/lib/session-types";
import type { SettingsSection } from "@/lib/settings-plan";
import { WaveField } from "@/app/entry-wave";
import { AppHeader } from "./AppHeader";
import { ProviderCredentials } from "./ProviderCredentials";

type Usage = { plan: Plan; planStatus: PlanStatus; effectivePlan: Plan; seconds: number; limitHours: number; limitSeats: number };
type Billing = { customerId: string | null; subscriptionId: string | null; plan: PaidPlan | null; quantity: number | null; stripeStatus: string | null; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean };
type BlockedSession = { id: string; title: string; reason: "integration_in_progress" };

const SETTINGS_SECTIONS: { value: SettingsSection; label: string }[] = [
  { value: "profile", label: "Profile" },
  { value: "plan", label: "Plan & usage" },
  { value: "connections", label: "Connections" },
  { value: "preferences", label: "Preferences" },
  { value: "danger", label: "Danger zone" },
];

// The left rail, not the horizontal ShopTabs strip /home owns: five section
// labels wrap on a narrow strip, and settings gets its own silhouette this
// way. Rows are fixed-height and full-width, so unlike ShopTabs (which
// measures a variable-width button to slide an indicator under it) the
// active row's floor-bracket marker is a plain CSS pseudo-element — no
// layout measurement needed. See app/styles/settings.css.
function SettingsRail({ value, onChange }: { value: SettingsSection; onChange: (value: SettingsSection) => void }) {
  return (
    <nav className="settings-rail" role="group" aria-label="Settings section">
      {SETTINGS_SECTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="settings-rail-item"
          data-tone={option.value === "danger" ? "danger" : undefined}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </nav>
  );
}

export function SettingsScreen({ user: initialUser, usage, billing, credentials, enabledProviders, githubInstallations, modelUsage, initialSection, billingNotice, backTo, originPath }: {
  user: AppUser;
  usage: Usage;
  billing: Billing;
  credentials: ProviderCredentialSummary[];
  enabledProviders: CredentialProvider[];
  githubInstallations: UserGitHubInstallationSummary[];
  modelUsage: MonthlyProviderUsage[];
  initialSection: SettingsSection;
  billingNotice: string | null;
  // Where "Account settings" was opened from — resolved server-side in
  // app/home/settings/page.tsx (app/home/settings/origin.ts) so the header link and
  // its label ("Sessions" or a real session title) always match a page the
  // user can actually return to.
  backTo: { href: string; label: string };
  // Same origin, threaded through to the Stripe round trip (PlanSection's
  // openBilling) so returning from Checkout/the billing portal still knows
  // where to go back to. null when the origin is just /home — nothing to add.
  originPath: string | null;
}) {
  const [user, setUser] = useState(initialUser);
  // Same render-time resync idiom as HomeScreen: router.refresh() re-renders
  // this Server Component prop without remounting SettingsScreen.
  const [syncedUser, setSyncedUser] = useState(initialUser);
  if (syncedUser !== initialUser) {
    setSyncedUser(initialUser);
    setUser(initialUser);
  }
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const router = useRouter();
  const pathname = usePathname();

  // The rail is client-only state, so a refresh has nothing to read back
  // except the URL. Every switch replaces `section` in it (dropping the
  // one-shot `billing` notice) so reloading — or a stuck-looking action
  // that makes someone hit refresh — lands back on the section they were on,
  // not always Profile. Read the current query from `window.location` rather
  // than `useSearchParams()`, which would force this page into a Suspense
  // boundary it doesn't otherwise need.
  function changeSection(next: SettingsSection) {
    setSection(next);
    const params = new URLSearchParams(window.location.search);
    params.set("section", next);
    params.delete("billing");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <main className="product-shell shop-shell settings-shell">
      <WaveField varName="--wave" className="shop-wave" />
      <AppHeader user={user} backTo={backTo} />
      <section className="page-body">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Account</p>
            <h1>Settings</h1>
            <p>Your profile, plan, and preferences.</p>
          </div>
        </div>

        <div className="settings-layout">
          <SettingsRail value={section} onChange={changeSection} />
          {/* key={section} remounts on every switch so the shop shell's
              rise-and-fade (shop-settle, app/styles/shop.css) replays
              each time, same as HomeScreen's tab-panel. */}
          <div className="settings-panel tab-panel" key={section}>
            {section === "profile" && <ProfileSection user={user} onSaved={setUser} />}
            {section === "plan" && <PlanSection usage={usage} billing={billing} modelUsage={modelUsage} billingNotice={billingNotice} originPath={originPath} />}
            {section === "connections" && <ConnectionsSection initialIdentity={user.verifiedGitHub ?? null} enabledProviders={enabledProviders} initialCredentials={credentials} initialGithubInstallations={githubInstallations} />}
            {section === "preferences" && <PreferencesSection user={user} />}
            {section === "danger" && <DangerZoneSection />}
          </div>
        </div>
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
  const [cropSource, setCropSource] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const ready = firstName.trim().length > 0 && lastName.trim().length > 0;
  const showRemove = removeAvatar ? false : avatarPreview ? false : user.avatarKey != null;

  // Revokes the previous preview whenever it is replaced, and the last one on
  // unmount — same shape as OnboardingScreen's picker, which matters more here
  // because re-cropping can mint several object URLs in one visit.
  useEffect(() => () => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  }, [avatarPreview]);

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
    setCropSource(file);
  }

  // The cropper hands back the framed square, so what is previewed here is
  // exactly what gets uploaded.
  function applyCrop(cropped: File) {
    setCropSource(null);
    setRemoveAvatar(false);
    setAvatarFile(cropped);
    setAvatarPreview(URL.createObjectURL(cropped));
  }

  function pickRemoveAvatar() {
    setError(null);
    setSaved(false);
    setAvatarFile(null);
    setAvatarPreview(null);
    setCropSource(null);
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
        <div className="field">
          <span className="label">Profile picture <em>optional</em></span>
          <div className="onboarding-avatar-picker">
            <label htmlFor="settings-avatar-input" className="onboarding-avatar-tile" aria-label="Choose profile picture">
              <Avatar
                userId={removeAvatar ? undefined : user.id}
                version={user.updatedAt}
                initials={initialsFromParts(firstName, lastName)}
                tone="you"
                previewSrc={avatarPreview ?? undefined}
              />
            </label>
            <AvatarFileButton hasPicture={Boolean(avatarPreview) || (!removeAvatar && user.avatarKey != null)} onPick={pickAvatar} inputId="settings-avatar-input" />
            {showRemove && (
              <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={pickRemoveAvatar}>Remove picture</button>
            )}
          </div>
        </div>

        <div className="field-grid">
          <label className="field"><span className="label">First name</span><input value={firstName} onChange={(event) => setFirstName(event.target.value)} maxLength={50} required /></label>
          <label className="field"><span className="label">Last name</span><input value={lastName} onChange={(event) => setLastName(event.target.value)} maxLength={50} required /></label>
        </div>

        <label className="field"><span className="label">GitHub handle <em>optional</em></span><input value={githubHandle} onChange={(event) => setGithubHandle(event.target.value)} maxLength={39} placeholder="octocat" /></label>

        {error && <p className="form-error" role="alert">{error}</p>}
        {saved && !error && <p className="notice" role="status">Saved.</p>}
        <div className="form-actions"><button className="button" data-variant="primary" disabled={!ready || submitting}>{submitting ? <><Spinner />Saving…</> : "Save changes"}</button></div>
      </form>

      {cropSource && <AvatarCropper file={cropSource} onCancel={() => setCropSource(null)} onCropped={applyCrop} />}

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

function PlanSection({ usage, billing, modelUsage, billingNotice, originPath }: { usage: Usage; billing: Billing; modelUsage: MonthlyProviderUsage[]; billingNotice: string | null; originPath: string | null }) {
  const limitSeconds = usage.limitHours * 3600;
  const lowHours = lowHoursRemaining(usage.seconds, usage.limitHours);
  const limitedHours = Number.isFinite(usage.limitHours);
  const limitedSeats = Number.isFinite(usage.limitSeats);
  const [selectedPlan, setSelectedPlan] = useState<PaidPlan>(billing.plan ?? "pro");
  const [quantity, setQuantity] = useState(billing.quantity ?? 3);
  const [submitting, setSubmitting] = useState<"checkout" | "change" | "portal" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeStripeSubscription = billing.subscriptionId != null && billing.stripeStatus != null && !["canceled", "incomplete_expired"].includes(billing.stripeStatus);
  const catalog = PAID_PLAN_CATALOG[selectedPlan];
  // Carries the settings origin through the Stripe round trip, so returning
  // from Checkout or the billing portal still knows where "back" goes.
  const fromSuffix = originPath ? `&from=${encodeURIComponent(originPath)}` : "";

  function choosePlan(plan: PaidPlan) {
    setSelectedPlan(plan);
    setQuantity((current) => Math.min(PAID_PLAN_CATALOG[plan].maximumSeats, Math.max(PAID_PLAN_CATALOG[plan].minimumSeats, current)));
  }

  async function openBilling(kind: "checkout" | "change" | "portal") {
    setError(null);
    setSubmitting(kind);
    const response = await fetch(`${BASE_PATH}/api/billing/${kind === "change" ? "change" : kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(kind === "portal"
        ? { returnTo: `${BASE_PATH}/home/settings?section=plan${fromSuffix}` }
        : { plan: selectedPlan, quantity, returnTo: `${BASE_PATH}/home/settings?section=plan&billing=success${fromSuffix}` }),
    });
    const body = await response.json().catch(() => null) as { url?: string; error?: string } | null;
    if (!response.ok || !body?.url) {
      setError(body?.error ?? "Unable to open Stripe billing. Try again.");
      setSubmitting(null);
      return;
    }
    window.location.assign(body.url);
  }

  return (
    <ul className="settings-category-list">
      <li className="settings-category-row">
        <span className="settings-category-name">Plan</span>
        <span className="settings-category-detail">{planLabel(usage.effectivePlan)} plan — {planLimitsSummary(usage.effectivePlan)}.</span>
        {activeStripeSubscription && <button className="button" data-variant="quiet" disabled={submitting != null} onClick={() => openBilling("portal")}>{submitting === "portal" ? "Opening…" : "Manage billing"}</button>}
      </li>

      {billingNotice === "success" && <li className="notice" role="status">Billing updated. Stripe webhooks keep this plan in sync.</li>}
      {billingNotice === "cancelled" && <li className="notice" data-tone="attention" role="status">Checkout canceled. No paid plan was activated.</li>}

      {(usage.planStatus === "past_due" || usage.planStatus === "canceled") && (
        <li className="settings-category-row">
          <span className="settings-category-name">Billing status</span>
          <span className="settings-category-detail">
            {`Your ${planLabel(usage.plan)} plan is ${usage.planStatus === "past_due" ? "past due" : "canceled"} — Free plan limits apply until it's resolved.`}
          </span>
        </li>
      )}

      {billing.currentPeriodEnd != null && activeStripeSubscription && (
        <li className="settings-category-row">
          <span className="settings-category-name">Billing period</span>
          <span className="settings-category-detail">Current period ends <LocalDateTime timestamp={billing.currentPeriodEnd} />.</span>
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
          {lowHours != null && <strong className="usage-low">{` · ${formatDuration(lowHours)} left`}</strong>}
        </span>
      </li>

      <li className="settings-category-row">
        <span className="settings-category-name">Model usage this month</span>
        <span className="settings-category-detail">
          {modelUsage.length === 0 ? "No model usage this month (UTC)." : (
            <ul className="usage-model-list">
              {modelUsage.map((row) => (
                <li key={`${row.provider}-${row.kind}`}>
                  <span>{monthlyUsageLabel(row)}</span>
                  <span>{`$${(row.microUsd / 1_000_000).toFixed(2)} · ${formatTokens(row.inputTokens)} in / ${formatTokens(row.outputTokens)} out`}</span>
                </li>
              ))}
            </ul>
          )}
        </span>
      </li>

      <li className="settings-category-row">
        <span className="settings-category-name">Seats</span>
        <span className="settings-category-detail">{limitedSeats ? `${usage.limitSeats} seats per session` : "Unlimited seats per session"}</span>
      </li>

      {usage.effectivePlan !== "enterprise" && (
        <li className="settings-category-row billing-choice">
          <span className="settings-category-name">{activeStripeSubscription ? "Change plan" : "Paid plans"}</span>
          <span className="settings-category-detail">
            <span className="billing-plan-buttons">
              {(["pro", "max"] as const).map((plan) => (
                <button type="button" className="button" data-variant={selectedPlan === plan ? "primary" : "quiet"} onClick={() => choosePlan(plan)} key={plan}>
                  {`${planLabel(plan)} · $${PAID_PLAN_CATALOG[plan].unitAmountCents / 100}/seat/month`}
                </button>
              ))}
            </span>
            <span>{`${catalog.minimumSeats}–${catalog.maximumSeats} seats per session · ${planLimitsSummary(selectedPlan).replace(/^\d+ seats per session, /, "")}`}</span>
            <span className="seat-picker">
              <span>{`Seats per session: ${quantity}`}</span>
              <button type="button" className="button" data-variant="quiet" disabled={quantity <= catalog.minimumSeats} onClick={() => setQuantity((value) => value - 1)} aria-label="Remove one seat">−</button>
              <button type="button" className="button" data-variant="quiet" disabled={quantity >= catalog.maximumSeats} onClick={() => setQuantity((value) => value + 1)} aria-label="Add one seat">+</button>
            </span>
          </span>
          <button className="button" data-variant="primary" disabled={submitting != null} onClick={() => openBilling(activeStripeSubscription ? "change" : "checkout")}>
            {submitting === (activeStripeSubscription ? "change" : "checkout") ? "Opening…" : activeStripeSubscription ? "Review prorated change" : "Subscribe"}
          </button>
        </li>
      )}

      <li className="settings-category-row">
        <span className="settings-category-name">Enterprise</span>
        <span className="settings-category-detail">Unlimited seats and session time. Talk with us about team billing and support.</span>
        <a className="button" data-variant="quiet" href="mailto:hello@opnflr.com">Contact sales</a>
      </li>
      {error && <li><p className="form-error" role="alert">{error}</p></li>}
    </ul>
  );
}

function ConnectionsSection({ initialIdentity, initialCredentials, initialGithubInstallations, enabledProviders }: { initialIdentity: import("@/lib/github-identity").GitHubIdentity | null; enabledProviders: CredentialProvider[]; initialCredentials: ProviderCredentialSummary[]; initialGithubInstallations: UserGitHubInstallationSummary[] }) {
  const [installations, setInstallations] = useState(initialGithubInstallations);
  const [verifiedLogin, setVerifiedLogin] = useState(initialIdentity?.login ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);

  function connectGitHub() {
    setError(null);
    setDeviceDialogOpen(true);
  }

  // Returning from the App-install redirect. "verify" means the callback
  // couldn't capture the installer's repo scope (no OAuth code configured, or
  // the exchange failed) — reopen the device dialog to capture it;
  // "connected" means the scope landed and there is nothing left to do.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const github = params.get("github");
    if (github !== "connected" && github !== "verify") return;
    params.delete("github");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    if (github === "verify") {
      queueMicrotask(() => setDeviceDialogOpen(true));
    }
  }, []);

  async function removeGitHub(id: string) {
    setBusy(id);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/account/github/installations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      setError(body?.error ?? "Unable to remove GitHub access.");
    } else {
      setInstallations((current) => current.filter((installation) => installation.id !== id));
    }
    setBusy(null);
  }

  return (
    <>
      <ul className="settings-category-list">
        <li className="settings-category-row">
          <span className="settings-category-name">GitHub</span>
          <span className="settings-category-detail">Git commits credit your verified personal GitHub account using its private noreply address. Connected installations supply repositories when creating sessions. After changing repository access on GitHub, refresh to verify your updated permissions. Removing access affects future selection only; existing session connections remain intact.</span>
          {installations.length > 0 && (
            <ul className="settings-github-installations">
              {installations.map((installation) => (
                <li className="settings-github-installation" key={installation.id}>
                  <span className="settings-category-name">{installation.accountLogin}</span>
                  <span className="settings-category-detail">{[installation.accountType, repoCountLabel(installation.repoCount), installation.status === "active" ? "Connected" : "Access revoked"].filter(Boolean).join(" · ")}</span>
                  <button className="button danger-button" disabled={busy != null} onClick={() => void removeGitHub(installation.id)}>{busy === installation.id ? "Removing…" : "Remove"}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="settings-github-actions">
          <p>{verifiedLogin ? <>GitHub credit: <a href={`https://github.com/${verifiedLogin}`} target="_blank" rel="noreferrer">@{verifiedLogin}</a></> : "Verify your GitHub account before code prompts can run."}</p>
          {installations.length > 0 && <button className="button" disabled={busy != null} onClick={connectGitHub}>Refresh repository access</button>}
          {/* Always offered — a second personal account or organization can
              be connected at any time, not just before the first one. */}
          <button className="button" data-variant={installations.length === 0 ? "primary" : undefined} disabled={busy != null} onClick={() => void connectGitHub()}>Add GitHub access</button>
          </div>
        </li>
        {error && <li><p className="form-error" role="alert">{error}</p></li>}
      </ul>
      {deviceDialogOpen && (
        <GitHubDeviceDialog
          purpose="settings"
          returnTo={`${BASE_PATH}/home/settings?section=connections`}
          onIdentity={(identity) => setVerifiedLogin(identity.login)}
          onConnected={setInstallations}
          onClose={() => setDeviceDialogOpen(false)}
        />
      )}
      <p className="settings-category-detail">
        Connect your own API keys and choose the default for your auto agents. Shared agents use their owner&rsquo;s key.
        openfloor does not provide model usage. Keys are encrypted and never returned to the browser.
      </p>
      <ProviderCredentials initialCredentials={initialCredentials} providers={enabledProviders} />
    </>
  );
}

function PreferencesSection({ user }: { user: AppUser }) {
  return (
    <ul className="settings-category-list">
      <li className="settings-category-row">
        <span className="settings-category-name">Do Not Disturb</span>
        <span className="settings-category-detail">Mutes the team chat unread badge everywhere, on every device.</span>
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
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedSessions, setBlockedSessions] = useState<BlockedSession[] | null>(null);
  const [orphanedBranches, setOrphanedBranches] = useState<string[] | null>(null);
  const ready = confirmText.trim() === "DELETE";

  async function remove() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setBlockedSessions(null);
    const response = await fetch(`${BASE_PATH}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", deleteBranches }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; sessions?: BlockedSession[] } | null;
      setError(body?.error ?? "Unable to delete your account.");
      setBlockedSessions(body?.sessions ?? null);
      setBusy(false);
      return;
    }
    const body = (await response.json().catch(() => null)) as { orphanedBranches?: string[] } | null;
    if (body?.orphanedBranches && body.orphanedBranches.length > 0) {
      setOrphanedBranches(body.orphanedBranches);
      setBusy(false);
      return;
    }
    // Leaves the app entirely — not a router navigation.
    window.location.assign(`${BASE_PATH}/signout`);
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
        {orphanedBranches ? (
          <>
            <p>Your account was deleted. These candidate branches are still on GitHub — nothing else references them:</p>
            <ul className="settings-category-list">
              {orphanedBranches.map((branch) => <li key={branch} className="settings-category-row"><span className="settings-category-name">{branch}</span></li>)}
            </ul>
          </>
        ) : blockedSessions && blockedSessions.length > 0 ? (
          <ul className="settings-category-list">
            {blockedSessions.map((session) => (
              <li key={session.id} className="settings-category-row">
                <span className="settings-category-name">{session.title}</span>
                <span className="settings-category-detail">This session&rsquo;s candidate branch is still being updated.</span>
                <Link className="button" data-variant="quiet" data-size="sm" href={`/session/${session.id}`}>Open</Link>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <label className="field"><span className="label">Type DELETE to confirm</span><input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoFocus /></label>
            <label className="settings-category-row">
              <input type="checkbox" checked={deleteBranches} onChange={(event) => setDeleteBranches(event.target.checked)} />
              <span className="settings-category-detail">Also delete any unmerged openfloor candidate branches on GitHub, where possible</span>
            </label>
          </>
        )}
      </div>
      <div className="dialog-foot">
        {orphanedBranches ? (
          <button type="button" className="button" onClick={() => window.location.assign(`${BASE_PATH}/signout`)}>Close</button>
        ) : (
          <>
            <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
            {!(blockedSessions && blockedSessions.length > 0) && (
              <button type="button" className="button danger-button" onClick={remove} disabled={!ready || busy}>{busy ? <><Spinner />Deleting…</> : "Delete account"}</button>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

"use client";

import { useId } from "react";
import { DoNotDisturbToggle } from "@/components/DoNotDisturbToggle";
import { effectivePlan, planLabel, PLAN_LIMITS, UPGRADE_URL } from "@/lib/plans";
import type { AppUser } from "@/lib/session-types";
import { Icon, useDialogDismiss } from "./primitives";

const INERT_CATEGORIES = [
  { name: "Profile", detail: "Name, avatar, and how you appear to others" },
  { name: "Appearance", detail: "Theme and layout preferences" },
];

export function SettingsDialog({ user, onClose }: { user: AppUser; onClose: () => void }) {
  const titleId = useId();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const plan = effectivePlan(user.plan, user.planStatus);
  const limits = PLAN_LIMITS[plan];

  return (
    <dialog className="dialog settings-dialog" {...dialogProps} aria-labelledby={titleId}>
      <div className="dialog-head">
        <div className="dialog-title"><h2 id={titleId}>Settings</h2><p>More controls are coming here soon.</p></div>
        <button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button>
      </div>
      <div className="dialog-body">
        <ul className="settings-category-list">
          <li className="settings-category-row">
            <span className="settings-category-name">Plan</span>
            <span className="settings-category-detail">
              {planLabel(plan)} plan — {Number.isFinite(limits.seats) ? `${limits.seats} seats per session` : "unlimited seats per session"},{" "}
              {Number.isFinite(limits.hours) ? `${limits.hours}h of session time per month` : "unlimited session time"}.
            </span>
            {plan === "free" && <a className="button" data-variant="quiet" href={UPGRADE_URL} target="_blank" rel="noreferrer noopener">Upgrade</a>}
          </li>
          <li className="settings-category-row">
            <span className="settings-category-name">Notifications</span>
            <span className="settings-category-detail">Do Not Disturb mutes the team chat unread badge everywhere, on every device.</span>
            <DoNotDisturbToggle initialValue={user.doNotDisturb} />
          </li>
          {INERT_CATEGORIES.map((category) => (
            <li key={category.name} className="settings-category-row" aria-disabled="true">
              <span className="settings-category-name">{category.name}</span>
              <span className="settings-category-detail">{category.detail}</span>
              <span className="settings-category-badge">Coming soon</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="dialog-foot"><button type="button" className="button" data-variant="quiet" onClick={dismiss}>Done</button></div>
    </dialog>
  );
}

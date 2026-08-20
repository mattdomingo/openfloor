"use client";

import { useId } from "react";
import { Icon, useDialogDismiss } from "./primitives";

const CATEGORIES = [
  { name: "Profile", detail: "Name, avatar, and how you appear to others" },
  { name: "Notifications", detail: "Email and in-app alerts for session activity" },
  { name: "Appearance", detail: "Theme and layout preferences" },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);

  return (
    <dialog className="dialog settings-dialog" {...dialogProps} aria-labelledby={titleId}>
      <div className="dialog-head">
        <div className="dialog-title"><h2 id={titleId}>Settings</h2><p>More controls are coming here soon.</p></div>
        <button type="button" className="dialog-close" onClick={dismiss} aria-label="Close"><Icon name="close" /></button>
      </div>
      <div className="dialog-body">
        <ul className="settings-category-list">
          {CATEGORIES.map((category) => (
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

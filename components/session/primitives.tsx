"use client";

import { ReactNode, SyntheticEvent, useEffect, useRef, useState } from "react";
import { AgentStatus, Step } from "./data";

/* Native <dialog> unmounts the instant its parent drops it, which cuts off any exit
   transition. This opens the dialog on mount and turns dismissals into a short
   data-closing beat before onClose fires, so the modal-out fade can actually run. */
export function useDialogDismiss(onClose: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  /* The timer ends in native close(), not the onClose prop: close() restores focus to the
     trigger and fires the close event, which reaches the parent through the element's own
     onClose handler — so this effect needs no dependency on the (per-render) callback. */
  useEffect(() => {
    if (!closing) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => dialogRef.current?.close(), reduced ? 0 : 180); /* --dur-base */
    return () => window.clearTimeout(timer);
  }, [closing]);

  return {
    dismiss: () => setClosing(true),
    dialogProps: {
      ref: dialogRef,
      onClose,
      onCancel: (event: SyntheticEvent) => {
        event.preventDefault();
        setClosing(true);
      },
      "data-closing": closing ? "true" : undefined,
    },
  };
}

export type IconName =
  | "grip"
  | "arrowLeft"
  | "arrowRight"
  | "chevronLeft"
  | "chevronRight"
  | "chevronDown"
  | "expand"
  | "collapse"
  | "branch"
  | "file"
  | "clock"
  | "check"
  | "alert"
  | "circle"
  | "send"
  | "attach"
  | "external"
  | "plus"
  | "close"
  | "more"
  | "pencil"
  | "message"
  | "sliders";

const glyphs: Record<IconName, ReactNode> = {
  grip: (
    <>
      <circle cx="6" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="6" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  arrowLeft: <path d="M12.5 8H3.5M7 4.5 3.5 8 7 11.5" />,
  arrowRight: <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" />,
  chevronLeft: <path d="M10 3.5 5.5 8 10 12.5" />,
  chevronRight: <path d="M6 3.5 10.5 8 6 12.5" />,
  chevronDown: <path d="M3.5 6 8 10.5 12.5 6" />,
  expand: <path d="M9.5 3H13v3.5M13 3 8.75 7.25M6.5 13H3V9.5M3 13l4.25-4.25" />,
  collapse: <path d="M12.5 6.5H9V3M12.5 3 9 6.5M3.5 9.5H7V13M3.5 13 7 9.5" />,
  branch: (
    <>
      <circle cx="5" cy="4" r="1.6" />
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="11" cy="4" r="1.6" />
      <path d="M5 5.6v4.8M11 5.6v1.1a3 3 0 0 1-3 3H6.6" />
    </>
  ),
  file: (
    <>
      <path d="M4 2.5h4.8L12 5.7v7.8H4z" />
      <path d="M8.6 2.6v3.2h3.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.3l2.2 1.3" />
    </>
  ),
  check: <path d="M3.5 8.4 6.3 11.2 12.5 4.8" />,
  alert: (
    <>
      <path d="M8 3.2l5.2 9.4H2.8z" />
      <path d="M8 6.6v2.7M8 11.2h.01" />
    </>
  ),
  circle: <circle cx="8" cy="8" r="5.5" />,
  send: <path d="M8 13V3.4M4.2 7.2 8 3.4l3.8 3.8" />,
  attach: <path d="M10.6 5.6 6 10.2a1.9 1.9 0 0 0 2.7 2.7l4.6-4.6a3.3 3.3 0 0 0-4.7-4.7L3.7 8.5" />,
  external: <path d="M6 3.5h6.5V10M12.5 3.5 6 10" />,
  plus: <path d="M8 3.8v8.4M3.8 8h8.4" />,
  close: <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />,
  more: (
    <>
      <circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  pencil: (
    <>
      <path d="M10.8 3 13 5.2l-7 7H3.8v-2.2z" />
      <path d="M9.4 4.4 11.6 6.6" />
    </>
  ),
  message: <path d="M3.2 4.5h9.6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8l-2.6 2.3v-2.3H3.2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" />,
  sliders: (
    <>
      <path d="M4 13V7.6M4 5.2V3" />
      <circle cx="4" cy="6.4" r="1.3" fill="currentColor" stroke="none" />
      <path d="M8 13V9.6M8 7.2V3" />
      <circle cx="8" cy="8.4" r="1.3" fill="currentColor" stroke="none" />
      <path d="M12 13V10.6M12 8.2V3" />
      <circle cx="12" cy="9.4" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyphs[name]}
    </svg>
  );
}

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className="status-dot" data-status={status} aria-hidden="true" />;
}

export function Avatar({ initials, tone, typing }: { initials: string; tone: string; typing?: boolean }) {
  return (
    <span className="avatar" data-tone={tone} data-typing={typing ? "true" : undefined} aria-hidden="true">
      {initials}
    </span>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ steps, compact = false }: { steps: Step[]; compact?: boolean }) {
  return (
    <ol className="stepper" data-compact={compact ? "true" : "false"}>
      {steps.map((step, index) => (
        <li key={step.label} data-state={step.state} title={compact ? step.label : undefined}>
          <span className="step-mark">{step.state === "done" ? <Icon name="check" size={9} /> : <em>{index + 1}</em>}</span>
          <span className="step-label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

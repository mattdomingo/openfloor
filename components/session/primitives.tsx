"use client";

import { MouseEvent as ReactMouseEvent, ReactNode, SyntheticEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BASE_PATH } from "@/components/basePath";

/* Instant, mouse-following tooltip for any hoverable element. Native `title`
   has a long, browser-controlled show delay and stays pinned where the
   pointer entered rather than tracking it — this shows immediately and
   follows the cursor instead. Portaled to <body> so it isn't clipped or
   mispositioned by an ancestor with `backdrop-filter`/`transform` (both
   create a containing block for `position: fixed`, e.g. the top bar's blur).
   Usage: const tip = useHoverTip(); <span {...tip.handlers}>…</span>
   <HoverTip position={tip.position}>label</HoverTip> */
export function useHoverTip() {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const track = (event: ReactMouseEvent) => setPosition({ x: event.clientX, y: event.clientY });
  return {
    position,
    handlers: {
      onMouseEnter: track,
      onMouseMove: track,
      onMouseLeave: () => setPosition(null),
    },
  };
}

export function HoverTip({ position, children }: { position: { x: number; y: number } | null; children: ReactNode }) {
  if (position == null || typeof document === "undefined") return null;
  return createPortal(
    <span className="hover-tip" role="tooltip" style={{ left: position.x + 14, top: position.y + 18 }}>
      {children}
    </span>,
    document.body,
  );
}

/* Native <dialog> unmounts the instant its parent drops it, which cuts off any exit
   transition. This opens the dialog on mount and turns dismissals into a short
   data-closing beat before onClose fires, so the modal-out fade can actually run. */
export function useDialogDismiss(onClose: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return {
    dismiss: () => dialogRef.current?.close(),
    dialogProps: {
      ref: dialogRef,
      onClose,
      onCancel: (event: SyntheticEvent) => {
        event.preventDefault();
        dialogRef.current?.close();
      },
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
  | "sliders"
  | "eye"
  | "eyeOff"
  | "grid";

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
  eye: (
    <>
      <path d="M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z" />
      <circle cx="8" cy="8" r="1.6" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z" />
      <circle cx="8" cy="8" r="1.6" />
      <path d="M3 3l10 10" />
    </>
  ),
  grid: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
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

export function Avatar({
  initials,
  tone,
  online,
  typing,
  userId,
  version,
  previewSrc,
}: {
  initials: string;
  tone: string;
  online?: boolean;
  typing?: boolean;
  userId?: string;
  // GET /api/account/avatar/[userId] caches for 5 minutes, so a page holding
  // a full AppUser should pass its updatedAt here — a fresh upload/removal
  // bumps updated_at, which changes this query param and busts the stale
  // cached image immediately. Roster avatars (no full AppUser available)
  // omit it and simply accept up to 5 minutes of staleness for other people.
  version?: number;
  // A local object URL for a freshly picked file (onboarding, the settings
  // profile-picture picker) shown in place of the stored avatar until the
  // picker's owner saves or discards the change. Takes priority over userId.
  previewSrc?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const src = previewSrc ?? `${BASE_PATH}/api/account/avatar/${userId}${version != null ? `?v=${version}` : ""}`;
  // A version bump (fresh upload/removal) deserves a fresh attempt even if
  // an earlier version 404'd — without this, removing a picture and
  // immediately uploading a new one would stay stuck on initials. Reset
  // during render (React's documented pattern for this, same idiom as
  // HomeScreen's syncedSessions) rather than in an effect, to avoid the
  // extra render an effect-driven setState would cause.
  const [trackedSrc, setTrackedSrc] = useState(src);
  if (trackedSrc !== src) {
    setTrackedSrc(src);
    setImageFailed(false);
    setImageLoaded(false);
  }
  const hasImage = Boolean(previewSrc || userId) && !imageFailed;
  return (
    <span className="avatar" data-tone={tone} data-online={online ? "true" : undefined} data-typing={typing ? "true" : undefined} aria-hidden="true">
      {initials}
      {hasImage && <img src={src} alt="" className="onboarding-avatar-preview" data-loaded={imageLoaded ? "true" : undefined} onLoad={() => setImageLoaded(true)} onError={() => setImageFailed(true)} />}
    </span>
  );
}

function SegmentedOption<T extends string>({ option, pressed, onClick }: {
  option: { value: T; label: ReactNode; title?: string };
  pressed: boolean;
  onClick: () => void;
}) {
  // Always called (rules-of-hooks), only used when this option carries a
  // title (the icon-only case) — see useHoverTip/HoverTip above.
  const tip = useHoverTip();
  return (
    <>
      <button
        type="button"
        aria-pressed={pressed}
        aria-label={option.title}
        onClick={onClick}
        {...(option.title ? tip.handlers : undefined)}
      >
        {option.label}
      </button>
      {option.title && <HoverTip position={tip.position}>{option.title}</HoverTip>}
    </>
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
  // `title` names an icon-only option for hover + accessibility (shown via
  // the mouse-following HoverTip, not a native tooltip); a text `label`
  // already serves as its own accessible name, so `title` stays optional and
  // existing text-label callers are unaffected.
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <SegmentedOption key={option.value} option={option} pressed={value === option.value} onClick={() => onChange(option.value)} />
      ))}
    </div>
  );
}

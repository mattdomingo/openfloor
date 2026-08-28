"use client";

import { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useDialogDismiss } from "@/components/session/primitives";
import { ACCEPTED_AVATAR_TYPE_LIST } from "@/lib/avatar-constraints";
import {
  AVATAR_CROP_TYPE,
  AVATAR_MAX_ZOOM,
  AVATAR_MIN_ZOOM,
  AVATAR_OUTPUT_SIZE,
  avatarCropRect,
} from "@/lib/avatar-crop";

// CSS pixels. The window is a fixed square rather than a fluid one so the
// pan arithmetic has a single source of truth shared with avatarCropRect —
// a resizing window would need a ResizeObserver to keep offsets honest.
const WINDOW_SIZE = 288;
const NUDGE = 8;
const COARSE_NUDGE = 32;

/* Picking a file opens this: the picture is scaled to cover a square window
   that the user drags and zooms, and only the visible square is uploaded.
   The server still validates the result, so this is a framing tool, not a
   trust boundary. */
export function AvatarCropper({ file, onCancel, onCropped }: {
  file: File;
  onCancel: () => void;
  onCropped: (file: File) => void;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onCancel);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // The dialog is mounted per pick and unmounted on cancel or confirm, so the
  // file never changes underneath it — one URL created on mount, revoked on
  // unmount, no effect needed to keep them in step.
  const [source] = useState(() => URL.createObjectURL(file));
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(AVATAR_MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => URL.revokeObjectURL(source), [source]);

  const rect = natural
    ? avatarCropRect({ naturalWidth: natural.width, naturalHeight: natural.height, viewport: WINDOW_SIZE, zoom, offsetX: offset.x, offsetY: offset.y })
    : null;

  function pan(deltaX: number, deltaY: number) {
    setOffset((current) => ({ x: current.x + deltaX, y: current.y + deltaY }));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pan(event.clientX - drag.x, event.clientY - drag.y);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? COARSE_NUDGE : NUDGE;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    pan(move[0], move[1]);
  }

  async function confirm() {
    const image = imageRef.current;
    if (!image || !rect) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_OUTPUT_SIZE;
      canvas.height = AVATAR_OUTPUT_SIZE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot prepare the picture.");
      context.drawImage(image, rect.sourceX, rect.sourceY, rect.sourceSize, rect.sourceSize, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, AVATAR_CROP_TYPE, 0.92));
      if (!blob) throw new Error("This browser cannot prepare the picture.");
      onCropped(new File([blob], "avatar.webp", { type: AVATAR_CROP_TYPE }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The picture could not be prepared.");
      setBusy(false);
    }
  }

  return (
    <dialog className="dialog avatar-cropper" {...dialogProps} aria-labelledby="avatar-cropper-title">
      <div className="dialog-head">
        <div className="dialog-title">
          <h2 id="avatar-cropper-title">Position your picture</h2>
          <p>Drag the picture, or focus it and use the arrow keys. Only the circle is uploaded.</p>
        </div>
      </div>
      <div className="dialog-body">
        <div
          className="avatar-crop-window"
          role="group"
          aria-label="Picture position"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          style={{ width: WINDOW_SIZE, height: WINDOW_SIZE }}
        >
          <img
            ref={imageRef}
            src={source}
            alt="The picture you chose"
            draggable={false}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setError("That picture could not be opened.")}
            style={rect
              ? {
                width: rect.displayWidth,
                height: rect.displayHeight,
                left: (WINDOW_SIZE - rect.displayWidth) / 2 + rect.offsetX,
                top: (WINDOW_SIZE - rect.displayHeight) / 2 + rect.offsetY,
              }
              : { visibility: "hidden" }}
          />
          <span className="avatar-crop-mask" aria-hidden="true" />
        </div>
        <label className="field avatar-crop-zoom">
          <span className="label">Zoom</span>
          <input
            type="range"
            min={AVATAR_MIN_ZOOM}
            max={AVATAR_MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!rect}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
        <button type="button" className="button" data-variant="primary" onClick={confirm} disabled={!rect || busy}>
          {busy ? "Preparing…" : "Use picture"}
        </button>
      </div>
    </dialog>
  );
}

/* A real button that opens a hidden input, rather than a styled <label> around
   it: <label> labels the first labelable descendant, which would be this button
   — renaming it after the field's caption. The input stays out of the tab order
   so the button is the only stop. Clearing value on change lets the same file be
   chosen again after a cancelled crop. */
export function AvatarFileButton({ hasPicture, onPick, inputId }: { hasPicture: boolean; onPick: (file: File | undefined) => void; inputId?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => inputRef.current?.click()}>
        {hasPicture ? "Change picture" : "Choose picture"}
      </button>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        className="sr-only avatar-file-input"
        tabIndex={-1}
        accept={ACCEPTED_AVATAR_TYPE_LIST.join(",")}
        onChange={(event) => {
          onPick(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

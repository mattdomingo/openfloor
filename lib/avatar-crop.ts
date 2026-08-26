// Pure crop geometry for the avatar cropper, kept out of the component for
// the same reason lib/avatar-constraints.ts is split from lib/account-avatar.ts:
// no DOM and no cloudflare:workers import, so tests/unit can exercise it under
// plain node while a "use client" bundle can still import it.

// Square edge of the uploaded picture. Large enough for the 64px pickers and
// any retina rendering of them, small enough that a WebP re-encode of a phone
// photo lands far under MAX_AVATAR_BYTES.
export const AVATAR_OUTPUT_SIZE = 512;
export const AVATAR_MIN_ZOOM = 1;
export const AVATAR_MAX_ZOOM = 4;
// Every crop is re-encoded to this type, so it must stay inside
// ACCEPTED_AVATAR_TYPES — the server validates the uploaded blob, not the
// file the user originally chose.
export const AVATAR_CROP_TYPE = "image/webp";

export type AvatarCropInput = {
  naturalWidth: number;
  naturalHeight: number;
  /** Edge of the square crop window, in CSS pixels. */
  viewport: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
};

export type AvatarCropRect = {
  /** Source rectangle in natural image pixels, for ctx.drawImage. */
  sourceX: number;
  sourceY: number;
  sourceSize: number;
  /** Displayed image box, in CSS pixels, relative to the viewport's top-left. */
  displayWidth: number;
  displayHeight: number;
  /** Pan after clamping — the UI stores these back so dragging stops at the edge. */
  offsetX: number;
  offsetY: number;
};

function clamp(value: number, min: number, max: number): number {
  // max < min happens only for a degenerate image; collapsing to min keeps
  // the result finite instead of returning NaN downstream.
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/* The picture is scaled to cover the square window, then panned. Zoom 1 is
   exactly cover, so the window is never allowed to see past an edge — that
   is also why the offsets are clamped here rather than in the drag handler:
   the confirm path and the live preview must agree on the same rectangle. */
export function avatarCropRect(input: AvatarCropInput): AvatarCropRect {
  const { naturalWidth, naturalHeight, viewport } = input;
  const zoom = clamp(input.zoom, AVATAR_MIN_ZOOM, AVATAR_MAX_ZOOM);
  if (naturalWidth <= 0 || naturalHeight <= 0 || viewport <= 0) {
    return { sourceX: 0, sourceY: 0, sourceSize: 0, displayWidth: 0, displayHeight: 0, offsetX: 0, offsetY: 0 };
  }
  const scale = (viewport / Math.min(naturalWidth, naturalHeight)) * zoom;
  const displayWidth = naturalWidth * scale;
  const displayHeight = naturalHeight * scale;
  // Centered at rest; a positive offset moves the picture right/down, so the
  // travel range runs from "right/bottom edge flush" to "left/top edge flush".
  const restX = (viewport - displayWidth) / 2;
  const restY = (viewport - displayHeight) / 2;
  const offsetX = clamp(input.offsetX, viewport - displayWidth - restX, -restX);
  const offsetY = clamp(input.offsetY, viewport - displayHeight - restY, -restY);
  const left = restX + offsetX;
  const top = restY + offsetY;
  return {
    sourceX: -left / scale,
    sourceY: -top / scale,
    sourceSize: viewport / scale,
    displayWidth,
    displayHeight,
    offsetX,
    offsetY,
  };
}

// Client-safe limits for session file sharing (ENG-113), split from the
// server-only R2 module the same way avatar-constraints.ts is split from
// account-avatar.ts: lib/session-files.ts imports cloudflare:workers and can
// never enter a "use client" bundle.

export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_FILES_PER_UPLOAD = 8;
export const MAX_SESSION_FILE_NAME_CHARS = 200;

// The only types the file route serves inline; everything else downloads as
// an attachment so an uploaded HTML or SVG file can never script the app
// origin. Upload deliberately accepts any type — safety lives at serve time.
export const INLINE_SESSION_FILE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// Flattened to one path-safe line: path separators and ASCII control
// characters become spaces, and the result is never empty. Doubles as the
// filename segment agents see in the sandbox.
export function sanitizeSessionFileName(name: string): string {
  let flat = "";
  for (const char of name) {
    const code = char.codePointAt(0) ?? 32;
    flat += code < 32 || char === "/" || char === "\\" ? " " : char;
  }
  flat = flat.replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_FILE_NAME_CHARS).trim();
  return flat || "file";
}

export function formatSessionFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function validateSessionFileUploads(files: Array<{ name: string; size: number }>): string | null {
  if (files.length > MAX_SESSION_FILES_PER_UPLOAD) {
    return `You can upload at most ${MAX_SESSION_FILES_PER_UPLOAD} files at a time.`;
  }
  const oversized = files.find((file) => file.size > MAX_SESSION_FILE_BYTES);
  if (oversized) {
    return `"${oversized.name}" is too large (${formatSessionFileSize(oversized.size)}). Files must be 8MB or smaller.`;
  }
  const empty = files.find((file) => file.size === 0);
  if (empty) {
    return `"${empty.name}" is empty. Files must be at least 1 byte.`;
  }
  return null;
}

export function sessionUploadErrorMessage(status: number, serverError?: string | null): string {
  if (serverError && serverError.trim().length > 0) return serverError;
  if (status === 413) return "The upload is too large. Each file must be 8MB or smaller.";
  if (status === 400) return "The upload request was invalid. Each file must be between 1 byte and 8MB.";
  if (status === 401 || status === 403) return "You do not have permission to upload files to this session.";
  if (status === 404) return "Session not found.";
  if (status === 408 || status === 504) return "The upload timed out. Please try again.";
  if (status === 502 || status === 503) return "File upload is temporarily unavailable. Please try again shortly.";
  return "The upload could not be completed. Please try again.";
}

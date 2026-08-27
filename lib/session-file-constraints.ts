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

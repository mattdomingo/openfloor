/** Only the opening request belongs in Git history, never appended credentials,
 * code blocks, attachment contents, or the execution/session brief. Ambiguous
 * credential-bearing requests use a neutral title and retain the run link. */
export function runCommitMessage(prompt: string | null | undefined, runId: string): string {
  const opening = (prompt ?? "").trim().split(/[\r\n]/, 1)[0];
  const sensitive = /\b(password|passwd|secret|credential|token|authorization|bearer|api[ _-]?key|private[ _-]?key)\b|-----BEGIN|\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]+/i;
  const title = sensitive.test(opening) ? "Requested repository update" : opening
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/(["'`]).*?\1/g, "[value]")
    .replace(/\S{24,}/g, "[value]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Array.from(title || "Requested repository update").slice(0, 100).join("");
  return `${bounded}\n\nOpenfloor-Run: ${runId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 100)}\n`;
}

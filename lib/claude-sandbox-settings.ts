// Every Claude tool, including native file operations, runs inside the
// mandatory outer execution namespace. An inner Bash-only srt sandbox would
// hide the credential-free local broker and cannot strengthen that boundary.
export type ClaudeSandboxSettingsInput = { gatewayHost: string };

export function buildClaudeSandboxSettings(input: ClaudeSandboxSettingsInput): string {
  void input;
  return `${JSON.stringify({ sandbox: { enabled: false } }, null, 2)}\n`;
}

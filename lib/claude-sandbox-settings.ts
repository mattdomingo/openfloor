// The Claude runner's execution posture, written to the container user's
// ~/.claude/settings.json (settingSources: ["user"]) by the run workflow.
// Pure module (no cloudflare:workers) so the exact pinned posture is
// unit-testable.
//
// Every value here is pinned deliberately — do not fall back to SDK defaults:
// - enabled + failIfUnavailable: a container where bubblewrap cannot
//   initialize must fail the run, never silently execute unsandboxed.
// - allowUnsandboxedCommands: false: per the sandboxing docs this disables
//   the dangerouslyDisableSandbox fallback entirely — an unsandboxable
//   command is blocked, not escalated into the permission flow. Verified
//   empirically for headless sessions before this shipped (see AGENTS.md
//   decision log); re-verify if the SDK pin changes.
// - allowedDomains + allowManagedDomainsOnly: sandboxed subprocess egress is
//   limited to the openfloor gateway host (belt-and-braces: the CLI's own
//   model traffic bypasses the sandbox proxy per the docs, and §4's remote
//   MCP servers are contacted by the CLI, not by sandboxed Bash — so in
//   practice this allowlist keeps repository-controlled commands at
//   no-network, matching the Codex runner's networkAccessEnabled: false).
//   allowManagedDomainsOnly prevents a lower-precedence settings scope from
//   widening the list.

export type ClaudeSandboxSettingsInput = {
  gatewayHost: string;
  extraAllowedDomains?: string[];
};

export function buildClaudeSandboxSettings(input: ClaudeSandboxSettingsInput): string {
  const allowedDomains = [input.gatewayHost, ...(input.extraAllowedDomains ?? [])];
  return `${JSON.stringify(
    {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: {
          allowedDomains,
          allowManagedDomainsOnly: true,
        },
      },
    },
    null,
    2,
  )}\n`;
}

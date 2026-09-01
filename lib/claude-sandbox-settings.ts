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
// - bwrapPath: srt launches each Bash command through the root-owned identity
//   transition helper. The provider CLI remains openfloor-provider; only the
//   sandboxed command becomes openfloor-workspace.
// - allowedDomains is empty: model traffic and remote MCP stay in the trusted
//   provider process, while repository-controlled Bash needs no egress. This
//   also avoids a provider-owned proxy socket crossing the uid boundary.

export type ClaudeSandboxSettingsInput = { gatewayHost: string };

export function buildClaudeSandboxSettings(input: ClaudeSandboxSettingsInput): string {
  void input;
  return `${JSON.stringify(
    {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        bwrapPath: "/opt/openfloor/openfloor-workspace-bwrap",
        network: {
          allowedDomains: [],
          allowManagedDomainsOnly: true,
        },
      },
    },
    null,
    2,
  )}\n`;
}

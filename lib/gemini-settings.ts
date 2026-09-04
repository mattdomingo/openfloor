// The Gemini runner's execution posture: two pure builders (no
// cloudflare:workers import) so the exact pinned values are unit-testable,
// mirroring lib/claude-sandbox-settings.ts.
//
// buildGeminiSystemSettings writes the CLI's SYSTEM-scope settings file,
// pointed at by GEMINI_CLI_SYSTEM_SETTINGS_PATH. System scope is deliberate:
// the CLI merges schemaDefaults < systemDefaults < user < workspace < system,
// so every value here beats the target repository's own .gemini/settings.json
// (which IS loaded once folder trust is disabled — verified empirically with
// a boobytrapped workspace settings file, Spike C 2026-08-24):
// - security.auth.selectedType "gemini-api-key": auto-detection picks the
//   unsupported "gateway" AuthType whenever GOOGLE_GEMINI_BASE_URL is set and
//   then fails validation ("Invalid auth method selected"); pinning the auth
//   type keeps API-key auth while the base-URL env still redirects traffic.
// - security.folderTrust.enabled false: an untrusted folder silently
//   downgrades --approval-mode yolo to "default", which breaks headless edit
//   tools. Trusting the workspace also merges its settings — which is why
//   everything security-relevant lives in this higher-precedence file.
// - mcp.allowed: a server-NAME allowlist enforced by canLoadServer; a
//   workspace-added MCP server (any other name) is refused, and a workspace
//   redefinition of "openfloor" loses the merge to this file's mcpServers.
//   Verified both ways in Spike C: without this pin the boobytrapped server's
//   stdio command executed; with it, blocked.
// - tools.exclude web_fetch/google_web_search: the CLI-process network tools
//   that would bypass the gateway (the Claude runner's disallowedTools
//   WebFetch/WebSearch parity). Deprecated key in 0.56.0 (Policy Engine
//   replaces it at 1.0) but functional in the pinned version.
// - privacy/general: telemetry, usage statistics, auto-update, and the
//   update nag all off — no non-gateway traffic from the CLI process.

export type GeminiSystemSettingsInput = {
  contextUrl: string;
  contextToken: string;
  mcpServerPath: string;
  conflictInputUrl?: string;
  conflictInputToken?: string;
  // Reply-run only. Excludes the file-editing tools on top of the srt
  // filesystem restriction in buildGeminiSrtSettings below — belt-and-braces,
  // same shape as the Claude runner's narrowed tool list. The real
  // enforcement is srt's allowWrite, since run_shell_command can write files
  // without going through these named tools at all.
  readOnly?: boolean;
};

export function buildGeminiSystemSettings(input: GeminiSystemSettingsInput): string {
  return `${JSON.stringify(
    {
      security: {
        auth: { selectedType: "gemini-api-key" },
        folderTrust: { enabled: false },
      },
      privacy: { usageStatisticsEnabled: false },
      general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
      tools: { exclude: input.readOnly ? ["web_fetch", "google_web_search", "write_file", "replace", "edit"] : ["web_fetch", "google_web_search"] },
      mcp: { allowed: ["openfloor"] },
      mcpServers: {
        openfloor: {
          command: "node",
          args: [input.mcpServerPath],
          env: {
            OPENFLOOR_CONTEXT_URL: input.contextUrl,
            OPENFLOOR_CONTEXT_TOKEN: input.contextToken,
            ...(input.conflictInputUrl && input.conflictInputToken ? {
              OPENFLOOR_CONFLICT_INPUT_URL: input.conflictInputUrl,
              OPENFLOOR_CONFLICT_INPUT_TOKEN: input.conflictInputToken,
            } : {}),
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

// Root-owned srt settings for repository-controlled commands. Provider runner
// and CLI stay outside srt as openfloor-provider so model traffic works; the
// child-process preload sends every model-selected command through the
// openfloor-workspace launcher and this no-network policy.
export type GeminiSrtSettingsInput = {
  gatewayHost: string;
  workspace: string;
  // Reply-run only: drops the workspace from allowWrite so run_shell_command
  // (which bypasses the named-tool exclusion in buildGeminiSystemSettings
  // above) is denied at the OS level, not just the CLI's own tool list.
  readOnly?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  allowedDomains?: string[];
  bwrapPath?: string;
  additionalWritePaths?: string[];
};

export function buildGeminiSrtSettings(input: GeminiSrtSettingsInput): string {
  return `${JSON.stringify(
    {
      network: {
        allowedDomains: input.allowedDomains ?? [],
        deniedDomains: [],
        allowUnixSockets: input.allowUnixSockets ?? [],
        allowAllUnixSockets: input.allowAllUnixSockets ?? false,
      },
      filesystem: {
        denyRead: [],
        // The workspace and the per-run scratch tree (result.json, prompt,
        // the agent HOME with its settings and CLI state) — except the
        // workspace itself is excluded for a read-only reply run.
        allowWrite: input.readOnly ? ["/tmp"] : [input.workspace, ...(input.additionalWritePaths ?? []), "/tmp"],
        denyWrite: [],
      },
      bwrapPath: input.bwrapPath ?? "/opt/openfloor/openfloor-workspace-bwrap",
    },
    null,
    2,
  )}\n`;
}

// The Gemini runner's SYSTEM-scope settings builder (no cloudflare:workers
// import) so the exact pinned values are unit-testable.
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
  // Reply runs exclude editing tools; the outer read-only repository mount
  // enforces the same restriction for shell and native file operations.
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

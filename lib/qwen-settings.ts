// The Qwen Code runner's execution posture, mirroring lib/gemini-settings.ts:
// a pure builder for the CLI's SYSTEM-scope settings file (pointed at by
// QWEN_CODE_SYSTEM_SETTINGS_PATH). System scope is deliberate: the CLI merges
// systemDefaults < user < workspace < system, so every value here beats the
// target repository's own .qwen/settings.json — which IS merged once folder
// trust is disabled (verified with a boobytrapped workspace file, Spike Q1
// 2026-08-28: its MCP server, SessionStart hook, auth-type flip, and
// tool-exclude reset all lost to this file). Every key below was verified by
// outcome against @qwen-code/qwen-code@0.22.3:
// - security.auth.selectedType "openai": OPENAI_API_KEY carries the run JWT
//   and OPENAI_BASE_URL points model traffic at the openfloor gateway.
// - security.folderTrust.enabled false: an untrusted folder downgrades
//   --approval-mode yolo, breaking headless edits (the Gemini precedent).
// - privacy.usageStatisticsEnabled false: kills the CLI's only non-gateway
//   egress, Alibaba RUM (`*.rum.aliyuncs.com`). general.enableAutoUpdate and
//   telemetry.enabled off for the same reason (neither fired headless, both
//   pinned anyway).
// - memory.*: false — with them on, the CLI makes a SECOND model call after
//   every turn ("managed memory extraction subagent") through the gateway,
//   doubling the bill and writing ~/.qwen/projects/<slug>/memory.
// - permissions.deny web_fetch/web_search: the CLI-process network tools that
//   would bypass the gateway (the canonical form; tools.exclude is legacy and
//   auto-migrated into it). A reply run also denies the file-editing tools —
//   in addition to the read-only repository mount, since run_shell_command can write
//   without them.
// - tools.toolSearch.enabled false: Qwen defers MCP tools behind its own
//   tool_search tool by default, so the openfloor context tool never reached
//   the model's tool list until this was off (round trip verified with it).
// - mcp.allowed: a server-NAME allowlist; a workspace-added server of any
//   other name is refused and a redefinition of "openfloor" loses the merge.
// - disableAllHooks: workspace .qwen/settings.json hooks (which run shell
//   commands) never fire.
import { type GeminiSystemSettingsInput } from "./gemini-settings";

export type QwenSystemSettingsInput = GeminiSystemSettingsInput;

export function buildQwenSystemSettings(input: QwenSystemSettingsInput): string {
  return `${JSON.stringify(
    {
      security: {
        auth: { selectedType: "openai" },
        folderTrust: { enabled: false },
      },
      privacy: { usageStatisticsEnabled: false },
      general: { enableAutoUpdate: false },
      telemetry: { enabled: false },
      memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false },
      permissions: { deny: input.readOnly ? ["web_fetch", "web_search", "write_file", "edit", "notebook_edit"] : ["web_fetch", "web_search"] },
      tools: { toolSearch: { enabled: false } },
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
      disableAllHooks: true,
    },
    null,
    2,
  )}\n`;
}

import { describe, expect, it } from "vitest";
import { buildQwenSystemSettings } from "@/lib/qwen-settings";

const SYSTEM_INPUT = {
  contextUrl: "https://opnflr.com/app/runtime/run/context",
  contextToken: "context-jwt",
  mcpServerPath: "/opt/openfloor/openfloor-mcp.mjs",
};

type Settings = {
  security: { auth: { selectedType: string }; folderTrust: { enabled: boolean } };
  privacy: { usageStatisticsEnabled: boolean };
  general: { enableAutoUpdate: boolean };
  telemetry: { enabled: boolean };
  memory: { enableManagedAutoMemory: boolean; enableManagedAutoDream: boolean; enableAutoSkill: boolean };
  permissions: { deny: string[] };
  tools: { toolSearch: { enabled: boolean } };
  mcp: { allowed: string[] };
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  disableAllHooks: boolean;
};

describe("qwen system settings", () => {
  it("pins the full CLI posture explicitly (every key Spike Q1 verified by outcome)", () => {
    const settings = JSON.parse(buildQwenSystemSettings(SYSTEM_INPUT)) as Settings;
    // The run JWT rides OPENAI_API_KEY; the auth type must be pinned so the
    // CLI never reaches for a Qwen OAuth login.
    expect(settings.security.auth.selectedType).toBe("openai");
    // Untrusted folders downgrade yolo; trust is off and the posture lives in
    // this SYSTEM-scope file, which beats the workspace's .qwen/settings.json.
    expect(settings.security.folderTrust.enabled).toBe(false);
    // The only non-gateway egress observed was RUM usage statistics.
    expect(settings.privacy.usageStatisticsEnabled).toBe(false);
    expect(settings.general.enableAutoUpdate).toBe(false);
    expect(settings.telemetry.enabled).toBe(false);
    // Managed memory means a second model call after every turn.
    expect(settings.memory).toEqual({ enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false });
    expect(settings.permissions.deny).toEqual(["web_fetch", "web_search"]);
    // Deferred MCP tools never reach the model; the context bridge must.
    expect(settings.tools.toolSearch.enabled).toBe(false);
    expect(settings.mcp.allowed).toEqual(["openfloor"]);
    expect(Object.keys(settings.mcpServers)).toEqual(["openfloor"]);
    expect(settings.mcpServers.openfloor).toEqual({
      command: "node",
      args: ["/opt/openfloor/openfloor-mcp.mjs"],
      env: {
        OPENFLOOR_CONTEXT_URL: "https://opnflr.com/app/runtime/run/context",
        OPENFLOOR_CONTEXT_TOKEN: "context-jwt",
      },
    });
    expect(settings.disableAllHooks).toBe(true);
  });

  it("denies the file-editing tools on a read-only reply run", () => {
    const settings = JSON.parse(buildQwenSystemSettings({ ...SYSTEM_INPUT, readOnly: true })) as Settings;
    expect(settings.permissions.deny).toEqual(["web_fetch", "web_search", "write_file", "edit", "notebook_edit"]);
  });

  it("passes the conflict-input bridge through when a resolver run has one", () => {
    const settings = JSON.parse(buildQwenSystemSettings({
      ...SYSTEM_INPUT, conflictInputUrl: "https://opnflr.com/app/runtime/run/conflict-input", conflictInputToken: "conflict-jwt",
    })) as Settings;
    expect(settings.mcpServers.openfloor.env.OPENFLOOR_CONFLICT_INPUT_URL).toBe("https://opnflr.com/app/runtime/run/conflict-input");
    expect(settings.mcpServers.openfloor.env.OPENFLOOR_CONFLICT_INPUT_TOKEN).toBe("conflict-jwt");
  });

  it("emits a settings.json file body", () => {
    const body = buildQwenSystemSettings(SYSTEM_INPUT);
    expect(body.endsWith("\n")).toBe(true);
    expect(body).toContain('"security"');
  });
});

import { describe, expect, it } from "vitest";
import { buildGeminiSrtSettings, buildGeminiSystemSettings } from "@/lib/gemini-settings";

const SYSTEM_INPUT = {
  contextUrl: "https://opnflr.com/app/runtime/run/context",
  contextToken: "context-jwt",
  mcpServerPath: "/opt/openfloor/openfloor-mcp.mjs",
};

describe("gemini system settings", () => {
  it("pins the full CLI posture explicitly", () => {
    const settings = JSON.parse(buildGeminiSystemSettings(SYSTEM_INPUT)) as {
      security: { auth: { selectedType: string }; folderTrust: { enabled: boolean } };
      privacy: { usageStatisticsEnabled: boolean };
      general: { enableAutoUpdate: boolean; enableAutoUpdateNotification: boolean };
      tools: { exclude: string[] };
      mcp: { allowed: string[] };
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    // Auto-detection picks the unsupported "gateway" auth type whenever
    // GOOGLE_GEMINI_BASE_URL is set; the pin keeps API-key auth while the
    // base-URL redirection still applies.
    expect(settings.security.auth.selectedType).toBe("gemini-api-key");
    // An untrusted folder silently downgrades yolo and breaks headless edits;
    // trust is disabled and the security posture lives in this SYSTEM-scope
    // file, which beats workspace settings in the CLI's merge order.
    expect(settings.security.folderTrust.enabled).toBe(false);
    expect(settings.privacy.usageStatisticsEnabled).toBe(false);
    expect(settings.general.enableAutoUpdate).toBe(false);
    expect(settings.general.enableAutoUpdateNotification).toBe(false);
    // The CLI-process network tools that would bypass the gateway — the
    // Claude runner's disallowedTools WebFetch/WebSearch parity.
    expect(settings.tools.exclude).toEqual(["web_fetch", "google_web_search"]);
    // A workspace .gemini/settings.json CAN add MCP servers once trust is
    // disabled (verified with a boobytrap in Spike C); the name allowlist is
    // what refuses them.
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
  });

  it("emits a settings.json file body", () => {
    const body = buildGeminiSystemSettings(SYSTEM_INPUT);
    expect(body.endsWith("\n")).toBe(true);
    expect(body).toContain('"security"');
  });
});

describe("gemini srt settings", () => {
  it("denies command egress and confines writes", () => {
    const settings = JSON.parse(buildGeminiSrtSettings({ gatewayHost: "opnflr.com", workspace: "/workspace/repository" })) as {
      network: { allowedDomains: string[]; deniedDomains: string[]; allowUnixSockets: string[] };
      filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
    };
    expect(settings.network.allowedDomains).toEqual([]);
    expect(settings.network.deniedDomains).toEqual([]);
    expect(settings.network.allowUnixSockets).toEqual([]);
    expect(settings.filesystem.allowWrite).toEqual(["/workspace/repository", "/tmp"]);
    expect(settings.filesystem.denyRead).toEqual([]);
    expect(settings.filesystem.denyWrite).toEqual([]);
  });
});

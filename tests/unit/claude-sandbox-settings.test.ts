import { describe, expect, it } from "vitest";
import { buildClaudeSandboxSettings } from "@/lib/claude-sandbox-settings";

describe("claude sandbox settings", () => {
  it("pins the full execution posture explicitly", () => {
    const settings = JSON.parse(buildClaudeSandboxSettings({ gatewayHost: "opnflr.com" })) as {
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        bwrapPath: string;
        network: { allowedDomains: string[]; allowManagedDomainsOnly: boolean };
      };
    };
    expect(settings.sandbox.enabled).toBe(true);
    // A container where the sandbox cannot initialize must fail the run,
    // never silently execute unsandboxed.
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    // Disables the dangerouslyDisableSandbox fallback entirely — an
    // unsandboxable command is blocked, not escalated.
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.bwrapPath).toBe("/opt/openfloor/openfloor-workspace-bwrap");
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
    expect(settings.sandbox.network.allowManagedDomainsOnly).toBe(true);
  });

  it("emits a settings.json file body", () => {
    const body = buildClaudeSandboxSettings({ gatewayHost: "opnflr.com" });
    expect(body.endsWith("\n")).toBe(true);
    expect(body).toContain('"sandbox"');
  });
});

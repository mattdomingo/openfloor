import { describe, expect, it } from "vitest";
import { sandboxArguments } from "../../scripts/runtime-sandbox.mjs";

describe("execution namespace arguments", () => {
  it("gives CAP_NET_ADMIN only to the preview loopback setup shell", () => {
    const run = sandboxArguments(["true"]).join("\0");
    const preview = sandboxArguments(["true"], {}, { loopback: true }).join("\0");
    expect(run).not.toContain("CAP_NET_ADMIN");
    expect(run).not.toContain("ip link set lo up");
    expect(preview).toContain("CAP_NET_ADMIN");
    expect(preview).toContain("ip link set lo up");
    expect(preview).toContain("openfloor-loopback");
  });

  it("binds extra preview files and directories only when requested", () => {
    const run = sandboxArguments(["true"]).join("\0");
    const preview = sandboxArguments(["true"], {}, {
      extraRoFiles: ["preview-runtime.mjs"],
      extraBinds: ["/workspace/preview-relay"],
    }).join("\0");
    expect(run).not.toContain("preview-runtime.mjs");
    expect(run).not.toContain("/workspace/preview-relay");
    expect(preview).toContain("/opt/openfloor/preview-runtime.mjs");
    expect(preview).toContain("/workspace/preview-relay");
  });
});

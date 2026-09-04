import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewBrowser, PreviewLifecycle } from "../../components/session/ReviewScreen";
import type { RepositoryPreviewSnapshot } from "../../lib/floor-types";

const ready: RepositoryPreviewSnapshot = {
  status: "ready",
  targetCandidateSha: "a".repeat(40),
  activeCandidateSha: "a".repeat(40),
  url: "https://8080-preview-v11-id-token.preview.opnflr.com",
  packageManager: "npm",
  script: "dev",
  failureReason: null,
  expiresAt: Date.UTC(2026, 7, 27, 12),
  createdAt: Date.UTC(2026, 7, 27, 11),
  updatedAt: Date.UTC(2026, 7, 27, 11),
};

describe("Review app preview", () => {
  it("renders honest no-preview and provisioning states", () => {
    expect(renderToStaticMarkup(<PreviewBrowser preview={null} />)).toContain("No app preview");
    expect(renderToStaticMarkup(<PreviewBrowser preview={{ ...ready, status: "provisioning", url: null, activeCandidateSha: null }} />))
      .toContain("Building preview");
  });

  it("renders interactive browser chrome and iframe for members", () => {
    const html = renderToStaticMarkup(<PreviewBrowser preview={ready} />);
    expect(html).toContain("Preview URL");
    expect(html).toContain("Open in new tab");
    expect(html).toContain(`src="${ready.url}"`);
    expect(html).toContain("allow-same-origin allow-scripts");
    expect(html).not.toContain("allow-top-navigation");
  });

  it("shows stale and failed fallback without removing iframe", () => {
    const preview = { ...ready, status: "failed" as const, targetCandidateSha: "b".repeat(40), failureReason: "Build failed" };
    const lifecycle = renderToStaticMarkup(<PreviewLifecycle preview={preview} owner busy={false} onStart={async () => true} onStop={async () => true} />);
    const browser = renderToStaticMarkup(<PreviewBrowser preview={preview} />);
    expect(lifecycle).toContain("stale");
    expect(lifecycle).toContain("Build failed");
    expect(lifecycle).toContain("Rebuild preview");
    expect(browser).toContain("Showing prior candidate");
    expect(browser).toContain("<iframe");
  });

  it("keeps owner controls owner-only and renders expired state", () => {
    const member = renderToStaticMarkup(<PreviewLifecycle preview={ready} owner={false} busy={false} onStart={async () => true} onStop={async () => true} />);
    expect(member).not.toContain("Rebuild preview");
    expect(member).not.toContain("Stop preview");
    expect(renderToStaticMarkup(<PreviewBrowser preview={{ ...ready, status: "expired", url: null }} />)).toContain("Preview expired");
  });
});

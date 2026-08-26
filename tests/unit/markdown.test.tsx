import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/session/Markdown";

const render = (source: string) => renderToStaticMarkup(<Markdown>{source}</Markdown>);

describe("rendered prose", () => {
  it("formats the dialects models actually emit", () => {
    const html = render("# Title\n\n- one\n- two\n\n`inline` and **bold**\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<code>inline</code>");
    expect(html).toContain("<strong>bold</strong>");
    // GFM table support, which plain CommonMark would render as a paragraph.
    expect(html).toContain("<table>");
  });

  it("escapes embedded HTML instead of running it", () => {
    const html = render('Look <script>alert(1)</script> and <img src=x onerror="alert(2)">');
    // Both arrive as visible text: no live element, and no attribute the
    // browser would ever parse as a handler.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="alert(2)"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
  });

  it("opens links in a new tab without leaking the opener", () => {
    const html = render("[docs](https://example.com)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("links images rather than loading them from an arbitrary host", () => {
    const html = render("![a beacon](https://tracker.example/pixel.gif)");
    expect(html).not.toContain("<img");
    expect(html).toContain("https://tracker.example/pixel.gif");
    expect(html).toContain("a beacon");
  });
});

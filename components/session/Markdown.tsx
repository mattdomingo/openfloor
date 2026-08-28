"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/* The one place prose becomes formatted output — teammate chat, prompt
   history, and the summaries agents write. Everything here is text this
   application did not author, so the safe defaults are deliberate:

   - react-markdown builds React elements, never an HTML string, and rehype-raw
     is not installed, so embedded HTML arrives as escaped text rather than
     markup. Nothing in this file may reach for dangerouslySetInnerHTML.
   - Links open in a new tab with rel="noreferrer noopener", so a link cannot
     reach back into the opener or leak the floor URL as a referrer.
   - Images render as a link rather than loading, since an <img> in agent
     output would hand an arbitrary host every viewer's IP and user agent.

   GFM is on for tables, task lists, strikethrough, and autolinks — the
   dialects models actually emit. */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => <a href={href} target="_blank" rel="noreferrer noopener">{label}</a>,
          img: ({ src, alt }) => (
            typeof src === "string"
              ? <a className="markdown-image-link" href={src} target="_blank" rel="noreferrer noopener">{alt || "image"}</a>
              : <span>{alt}</span>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

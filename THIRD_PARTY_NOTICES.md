# Third-party notices

The Apache 2.0 license covers openfloor-authored source. Dependencies retain their own licenses and notices; installing or using a service also remains subject to its provider terms. This is a direct runtime dependency inventory for the committed lockfile, not a replacement for the packages' complete license texts.

| Package | Installed version | License declaration |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.239 | SEE LICENSE IN README.md |
| `@cloudflare/sandbox` | 0.12.7 | Apache-2.0 |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `@openai/codex-sdk` | 0.148.0 | Apache-2.0 |
| `drizzle-orm` | 0.45.2 | Apache-2.0 |
| `ipaddr.js` | 2.5.0 | MIT |
| `jose` | 6.2.9 | MIT |
| `next` | 16.4.2 | MIT |
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `stripe` | 22.5.0 | MIT |
| `zod` | 4.4.3 | MIT |

Development dependencies and transitive dependencies also carry their own licenses. Keep upstream license and notice files when distributing them. Refresh this inventory when dependency versions change.

The Claude Agent SDK declares `SEE LICENSE IN README.md`; its `LICENSE.md` reserves copyright to Anthropic and refers to [Claude Code legal agreements](https://code.claude.com/docs/en/legal-and-compliance). Treat that SDK and its bundled executables under their upstream terms, not Apache 2.0. `Dockerfile.sandbox` additionally installs provider CLIs and a Cloudflare base image; review their licenses and service terms before redistributing or operating that image.

Provider names and logos under `public/logos/` identify their respective services. Their trademarks are not licensed by the openfloor source license.

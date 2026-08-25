// Loaded into the Gemini CLI via NODE_OPTIONS=--import by gemini-runner.mjs.
//
// srt's Linux sandbox is --unshare-net plus an env-var proxy
// (HTTP_PROXY=localhost:3128 bridged to the host's domain-filtering proxy) —
// cooperative clients only. Node 22's fetch (undici) ignores proxy env vars
// (NODE_USE_ENV_PROXY is Node 24+), and the CLI overwrites the global
// dispatcher at startup, so a setGlobalDispatcher preload would be clobbered.
// Wrapping fetch with an explicit per-request dispatcher survives both: the
// CLI's model traffic transits srt's proxy, and everything works unchanged
// when no proxy env is present (Plan-B or local runs).
import { createRequire } from "node:module";

const { EnvHttpProxyAgent } = createRequire(import.meta.url)("undici");

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  const agent = new EnvHttpProxyAgent();
  const base = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => base(input, { dispatcher: init.dispatcher ?? agent, ...init });
}

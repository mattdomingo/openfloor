import { env } from "cloudflare:workers";
import { fetchAccessCodeChallenge, normalizedTeamDomain } from "@/lib/access-login";
import { safeAppReturnPath } from "@/lib/access-paths";

export const dynamic = "force-dynamic";

// Step 2 of the custom email/one-time-code flow. This route does the
// server-side POST that mints Cloudflare's per-attempt CSRF nonce (see
// lib/access-login.ts), then renders the code-entry form directly in this
// same response — never as a redirect carrying the email/nonce in a URL,
// which would leak them into browser history and any Referer header. The
// rendered form's own action targets Cloudflare's team domain directly, so
// when the user submits it, that is a real top-level browser navigation
// straight to Cloudflare — confirmed live to work cross-origin with no CSRF
// rejection — and Cloudflare's own cookies land in the user's browser
// instead of this Worker's.
//
// A route handler can't render JSX, so this hand-builds the HTML string
// (escaping every interpolated value) rather than pull in a rendering
// dependency for one page. An earlier version tried to reuse the app's
// compiled stylesheet by extracting its (content-hashed, so undiscoverable
// any other way) URL from a same-origin self-fetch of the landing page.
// That self-fetch proved unreliable in the real Workers runtime — it failed
// in production (silently, by this route's own design: a failed fetch
// degrades to unstyled HTML rather than breaking sign-in), which is exactly
// what shipped looking broken. This inlines the small, fixed set of rules
// this one page actually needs instead — copied from the .entry-shell /
// .signin-* source of truth in app/styles/layout.css, with token values
// (--space-*, --radius-sm) hardcoded from app/styles/tokens.css since that
// stylesheet isn't loaded here either. No runtime dependency, nothing that
// can fail. Keep this in sync by hand if layout.css's .entry-shell/.signin-*
// rules change; there's no build step wiring the two together.
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const destination = safeAppReturnPath(url.searchParams.get("return_to")) ?? "/home";
  const fallback = () => new Response(null, { status: 302, headers: { Location: destination } });

  let email: string;
  let actionUrl: string;
  try {
    const form = await request.formData();
    const emailValue = form.get("email");
    const actionValue = form.get("action");
    if (typeof emailValue !== "string" || !emailValue || typeof actionValue !== "string" || !actionValue) {
      return fallback();
    }
    email = emailValue;
    actionUrl = actionValue;
  } catch {
    return fallback();
  }

  const teamDomain = normalizedTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  if (!teamDomain) return fallback();

  const testBindings = env as unknown as { OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION?: string };
  const challenge = await fetchAccessCodeChallenge(actionUrl, email, teamDomain, {
    testLocation: testBindings.OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION,
  });
  if (!challenge.ok) return fallback();

  const restartSignIn = `/signin?return_to=${encodeURIComponent(destination)}`;
  return new Response(renderCodeStep(challenge.nonce, challenge.callbackUrl, email, restartSignIn), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderCodeStep(nonce: string, callbackUrl: string, email: string, restartSignInHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Enter your code — openfloor</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<style>${INLINE_STYLE}</style>
</head>
<body>
<main class="entry-shell signin-shell">
  <div class="entry-backdrop">
    <div class="entry-glow" aria-hidden="true"></div>
    <div class="entry-grain" aria-hidden="true"></div>
  </div>
  <div class="entry-card signin-card">
    <div class="signin-mark" aria-hidden="true">
      <svg class="signin-mark-bracket" viewBox="0 0 3 8"><path fill="currentColor" d="M0 0h1v7h2v1H0Z"></path></svg>
      <span class="signin-mark-gap"><span class="signin-mark-text">open the floor</span></span>
      <svg class="signin-mark-bracket" viewBox="0 0 3 8"><path fill="currentColor" d="M3 0h-1v7h-2v1h3Z"></path></svg>
    </div>
    <p class="signin-code-body">We sent a code to ${escapeHtml(email)}. It expires in 10 minutes.</p>
    <form class="signin-email-form" method="POST" action="${escapeHtmlAttribute(callbackUrl)}">
      <input type="hidden" name="nonce" value="${escapeHtmlAttribute(nonce)}">
      <label class="sr-only" for="signin-code">Code</label>
      <input id="signin-code" class="signin-input signin-code-input" type="text" name="code" inputmode="numeric" pattern="[0-9]*" placeholder="000000" autocomplete="one-time-code" autofocus required>
      <button class="signin-button" type="submit">Verify</button>
    </form>
    <a class="signin-google" href="${escapeHtmlAttribute(restartSignInHref)}">Use a different email</a>
  </div>
</main>
</body>
</html>`;
}

// Subset of app/styles/base.css + app/styles/layout.css's .entry-shell /
// .signin-* rules, self-contained. Animations are dropped rather than
// inlining the keyframes too — this page loads once per sign-in attempt, so
// the landing/signin entrance choreography isn't worth the extra weight
// here; prefers-reduced-motion handling is therefore moot.
const INLINE_STYLE = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font-family:Archivo,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.entry-shell{position:relative;display:grid;place-items:center;min-height:100vh;overflow:hidden;background:#000;--entry-ink:#d7dadf;--entry-ink-muted:#9aa0a8;--entry-accent:#1b45b8;--entry-accent-hover:#2a56d1;--entry-glow-tint:rgba(27,69,184,.28)}
@media (prefers-color-scheme:light){.entry-shell{background:#c6ccd4;--entry-ink:#12181f;--entry-ink-muted:#565f6b;--entry-glow-tint:rgba(27,69,184,.12)}}
.entry-backdrop{position:absolute;inset:0}
.entry-glow{position:absolute;inset:0;background:radial-gradient(ellipse 640px 420px at 50% 42%,var(--entry-glow-tint),transparent 70%)}
.entry-grain{position:absolute;inset:0;opacity:.035;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.entry-card{position:relative;display:grid;justify-items:center;gap:18px;width:min(380px,calc(100% - 40px));text-align:center}
.signin-mark{display:flex;align-items:center;color:var(--entry-ink)}
.signin-mark-bracket{display:block;flex:none;height:44px;width:auto}
.signin-mark-gap{position:relative;display:flex;align-items:center;justify-content:center;height:44px;width:176px}
.signin-mark-text{white-space:nowrap;font-weight:600;font-size:15px}
.signin-card{gap:22px}
.signin-email-form{display:grid;gap:10px;width:100%}
.signin-input{width:100%;min-height:44px;padding:0 16px;border:1px solid rgba(215,218,223,.3);border-radius:4px;background:transparent;color:var(--entry-ink);font-family:inherit;font-size:15px}
.signin-input::placeholder{color:var(--entry-ink-muted)}
.signin-input:focus-visible{outline:2px solid var(--entry-accent);outline-offset:2px;border-color:var(--entry-accent);box-shadow:none}
.signin-code-input{font-family:ui-monospace,SFMono-Regular,monospace;font-size:20px;letter-spacing:.3em;text-align:center}
.signin-button{min-height:44px;border:none;border-radius:4px;background:var(--entry-accent);color:#fff;font-family:inherit;font-weight:600;font-size:15px;cursor:pointer}
.signin-button:hover{background:var(--entry-accent-hover)}
.signin-button:focus-visible{outline:2px solid var(--entry-ink);outline-offset:2px}
.signin-google{color:var(--entry-ink-muted);font-family:inherit;font-size:14px;text-decoration:none}
.signin-google:hover,.signin-google:focus-visible{color:var(--entry-ink);text-decoration:underline}
.signin-code-body{margin:0;color:var(--entry-ink-muted);font-family:inherit;font-size:14px;line-height:1.5}
`.trim();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

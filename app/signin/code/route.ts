import { env } from "cloudflare:workers";
import { fetchAccessCodeChallenge, normalizedTeamDomain, resolveOwnStylesheetHref } from "@/lib/access-login";
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
// dependency for one page. It reuses the exact .entry-shell / .signin-*
// class names /signin/page.tsx uses, so it inherits the same look and the
// same CSS-driven entrance animation with zero duplicated styling — the one
// deliberate omission is the animated WaveField canvas, which is a client
// component that needs React hydration; the static glow and grain (both
// pure CSS) carry the same backdrop without it.
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

  const testBindings = env as unknown as {
    OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION?: string;
    OPENFLOOR_TEST_LANDING_HTML?: string;
  };
  const challenge = await fetchAccessCodeChallenge(actionUrl, email, teamDomain, {
    testLocation: testBindings.OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION,
  });
  if (!challenge.ok) return fallback();

  const restartSignIn = `/signin?return_to=${encodeURIComponent(destination)}`;
  const stylesheetHref = await resolveOwnStylesheetHref(url.origin, { testHtml: testBindings.OPENFLOOR_TEST_LANDING_HTML });
  return new Response(renderCodeStep(challenge.nonce, challenge.callbackUrl, email, restartSignIn, stylesheetHref), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderCodeStep(nonce: string, callbackUrl: string, email: string, restartSignInHref: string, stylesheetHref: string | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Enter your code — openfloor</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${stylesheetHref ? `<link rel="stylesheet" href="${escapeHtmlAttribute(stylesheetHref)}">` : ""}
</head>
<body>
<main class="entry-shell signin-shell">
  <div class="entry-backdrop entry-anim">
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

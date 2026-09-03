// Extracts what /signin's custom email/one-time-code step needs from
// Cloudflare Access's own hosted login page. Google is deliberately NOT
// handled here — its OAuth callback needs a `CF_Session` cookie that only
// exists once the browser has visited the team domain directly, and a
// server-side fetch structurally cannot deliver that (confirmed live,
// 2026-08-25 decision log in AGENTS.md). /signin's Google control is a
// plain link into Cloudflare's own picker instead.
//
// Both functions here parse third-party HTML/headers into things this
// Worker will then fetch or redirect to, so every extracted URL is
// re-validated against the Access team domain before use — this is what
// stops a Cloudflare-side markup change, or a tampered client resubmission
// of the hidden `action` field, from turning into server-side request
// forgery or an open redirect. Nothing extracted is ever rendered as HTML;
// only these two URL fields are read out.

import { normalizedTeamDomain } from "@/lib/identity";

export type AccessLoginTarget =
  | { ok: true; emailAction: string }
  | { ok: false; reason: "unreachable" | "unrecognized" };

export type AccessLoginTargetOptions = {
  // Deterministic test adapter (same convention as GitHubAppConfig.testData
  // and validateProviderApiKey's testAcceptedKeys): when set — including to
  // "" — no network call is made and this fixture HTML is parsed instead.
  testHtml?: string | null;
};

const PRODUCTION_APP_ORIGIN = "https://app.opnflr.com";

export function accessLoginUrl(destination: string, configuredOrigin?: string): string {
  const origin = new URL(configuredOrigin ?? PRODUCTION_APP_ORIGIN);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("OPENFLOOR_RUNTIME_ORIGIN must be an HTTPS origin");
  }
  return new URL(destination, origin).toString();
}

// `meta` is a signed JWT Cloudflare mints fresh per request with a 300-second
// lifetime (confirmed live), so this can never be cached — call it once per
// /signin render. `loginUrl` is expected to be this Worker's configured public
// origin (app.opnflr.com or dev.app.opnflr.com). Both are Custom Domains,
// which — unlike a plain zone Route — Cloudflare Workers can fetch from within
// the same zone. The /auth/complete destination is intercepted by Access at
// the edge exactly as a browser's request would be and redirects to the hosted
// login page.
export async function fetchAccessLoginTarget(
  loginUrl: string,
  teamDomain: string | null,
  options: AccessLoginTargetOptions = {},
): Promise<AccessLoginTarget> {
  let html: string;
  if (options.testHtml !== undefined) {
    html = options.testHtml ?? "";
  } else {
    try {
      const response = await fetch(loginUrl, { redirect: "follow" });
      if (!response.ok) return { ok: false, reason: "unreachable" };
      html = await response.text();
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }

  const action = await extractEmailFormAction(html);
  if (!action || !teamDomain || !isTeamDomainUrl(action, teamDomain)) {
    return { ok: false, reason: "unrecognized" };
  }
  return { ok: true, emailAction: action };
}

export type AccessCodeChallenge =
  | { ok: true; nonce: string; callbackUrl: string }
  | { ok: false; reason: "unreachable" | "unrecognized" };

export type AccessCodeChallengeOptions = {
  // Fixture `Location` header value; presence (including "") skips the
  // network call, same convention as AccessLoginTargetOptions.testHtml.
  testLocation?: string | null;
};

// Submits the email server-side to the action extracted above and reads the
// fresh CSRF nonce Cloudflare returns in its redirect's query string — this
// needs no HTML scraping at all (confirmed live), only a validated fetch.
// `actionUrl` arrives back from the browser as a hidden form field on
// /signin's page, so it is client-controllable on this call and is
// re-validated here independently of fetchAccessLoginTarget's own check —
// without this, a tampered submission could turn this into an
// attacker-directed server-side POST.
export async function fetchAccessCodeChallenge(
  actionUrl: string,
  email: string,
  teamDomain: string,
  options: AccessCodeChallengeOptions = {},
): Promise<AccessCodeChallenge> {
  if (!isTeamDomainUrl(actionUrl, teamDomain)) return { ok: false, reason: "unrecognized" };

  let location: string | null;
  if (options.testLocation !== undefined) {
    location = options.testLocation;
  } else {
    try {
      const response = await fetch(actionUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email }),
        redirect: "manual",
      });
      location = response.headers.get("location");
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }
  if (!location) return { ok: false, reason: "unreachable" };

  let nonce: string | null;
  try {
    nonce = new URL(location, teamDomain).searchParams.get("nonce");
  } catch {
    return { ok: false, reason: "unrecognized" };
  }
  if (!nonce) return { ok: false, reason: "unrecognized" };

  return { ok: true, nonce, callbackUrl: `${teamDomain}/cdn-cgi/access/callback` };
}

// Re-exported so callers building a login URL for fetchAccessLoginTarget can
// validate CF_ACCESS_TEAM_DOMAIN the same way app/signout/route.ts already does.
export { normalizedTeamDomain };

async function extractEmailFormAction(html: string): Promise<string | null> {
  let action: string | null = null;
  const rewriter = new HTMLRewriter().on("form.AuthFormLogin", {
    element(el) {
      action = el.getAttribute("action");
    },
  });
  // HTMLRewriter is lazy — it only runs while the transformed body is read.
  await rewriter.transform(new Response(html)).text();
  // getAttribute() returns the raw source text, NOT entity-decoded (verified
  // empirically: `action='...&amp;...'` comes back containing the literal
  // 4 characters "&amp;", not "&") — Cloudflare's real markup does encode
  // this attribute's ampersands (and uses numeric refs like &#x2F; for
  // slashes elsewhere on the same page), so skipping this step would hand a
  // syntactically-valid but semantically-wrong URL (an extra literal
  // "amp;meta=..." query param instead of "meta=...") on to fetch().
  return action === null ? null : decodeHtmlEntities(action);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z0-9]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint = entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function isTeamDomainUrl(candidate: string, teamDomain: string): boolean {
  try {
    return new URL(candidate).origin === teamDomain;
  } catch {
    return false;
  }
}

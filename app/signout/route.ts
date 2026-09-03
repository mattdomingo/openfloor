import { env } from "cloudflare:workers";
import { BASE_PATH } from "@/components/basePath";
import { normalizedTeamDomain } from "@/lib/identity";

export const dynamic = "force-dynamic";

const LANDING_PATH = `${BASE_PATH}/`;

// Cloudflare's /cdn-cgi/access/logout only clears the CF_Authorization
// cookie on whichever domain served it, and neither the app-domain nor the
// team-domain logout endpoint accepts a returnTo. A sign-out that only hits
// the application domain leaves the team-domain global session alive
// and the next sign-in silently re-authenticates the same identity with no
// prompt. This route clears the app-domain cookie itself, then hands off to
// the team-domain logout to end that global session. It must stay outside
// the Access application's destinations — a signed-out user has to be able
// to reach it without first being challenged again.
//
// Since the team-domain logout won't redirect back to us, ending on
// Cloudflare's hosted "logged out" page is a dead end rather than the
// requested "land on our own landing page" behavior. There's no
// server-side redirect that fixes that — a 302 to the team domain still
// leaves the browser sitting wherever *that* page decides to stop. So this
// clears the team-domain session from the client instead: a cross-origin
// no-cors GET carries the same credentials and Set-Cookie handling a real
// navigation would, without ever leaving app.opnflr.com, then the script
// sends the browser to the landing page itself.
export async function GET() {
  const teamDomain = normalizedTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "set-cookie": "CF_Authorization=; Path=/; Max-Age=0; Secure; HttpOnly",
  };

  if (!teamDomain) {
    return new Response(null, { status: 302, headers: { ...headers, location: LANDING_PATH } });
  }

  const teamLogoutUrl = `${teamDomain}/cdn-cgi/access/logout`;
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Signing out…</title>
<style>html,body{background:#000;height:100%;margin:0}</style></head>
<body>
<script>
(function () {
  var done = false;
  function leave() {
    if (done) return;
    done = true;
    window.location.replace(${JSON.stringify(LANDING_PATH)});
  }
  fetch(${JSON.stringify(teamLogoutUrl)}, { mode: "no-cors", credentials: "include" }).then(leave, leave);
  setTimeout(leave, 2000);
})();
</script>
</body>
</html>`;

  return new Response(html, { status: 200, headers });
}

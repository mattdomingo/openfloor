import { env } from "cloudflare:workers";
import { BASE_PATH } from "@/components/basePath";
import { normalizedTeamDomain } from "@/lib/identity";

export const dynamic = "force-dynamic";

// Cloudflare's /cdn-cgi/access/logout only clears the CF_Authorization
// cookie on whichever domain served it, and neither the app-domain nor the
// team-domain logout endpoint accepts a returnTo. Production also splits the
// protected paths across two self-hosted Access applications on
// app.opnflr.com (AGENTS.md "Authentication and identity"), so a sign-out
// that only hits the app domain leaves the team-domain global session alive
// and the next sign-in silently re-authenticates the same identity with no
// prompt. This route clears the app-domain cookie itself, then hands off to
// the team-domain logout to end that global session. It must stay outside
// both Access applications' destinations — a signed-out user has to be able
// to reach it without first being challenged again.
export async function GET() {
  const teamDomain = normalizedTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const location = teamDomain ? `${teamDomain}/cdn-cgi/access/logout` : `${BASE_PATH}/`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Set-Cookie": "CF_Authorization=; Path=/; Max-Age=0; Secure; HttpOnly",
    },
  });
}

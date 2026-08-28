import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { fetchAccessLoginTarget, normalizedTeamDomain } from "@/lib/access-login";
import { protectedAccessPath, safeAppReturnPath } from "@/lib/access-paths";
import { EntryReplay } from "../entry-replay";
import { ParallaxLayer } from "../entry-parallax";
import { WaveField } from "../entry-wave";

export const dynamic = "force-dynamic";

// The same bracket mark as the landing's sign-in control (app/page.tsx), but
// held in its "open" state rather than triggered by hover — the gesture the
// user just completed on the landing page, continued here as this page's one
// signature element. Not a link: there's nothing to navigate to yet.
function SignInMark() {
  return (
    <div className="signin-mark" aria-hidden="true">
      <svg className="signin-mark-bracket" viewBox="0 0 3 8">
        <path fill="currentColor" d="M0 0h1v7h2v1H0Z" />
      </svg>
      <span className="signin-mark-gap">
        <span className="signin-mark-text">open the floor</span>
      </span>
      <svg className="signin-mark-bracket" viewBox="0 0 3 8">
        <path fill="currentColor" d="M3 0h-1v7h-2v1h3Z" />
      </svg>
    </div>
  );
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeAppReturnPath(params.return_to) ?? "/home";
  const destination = protectedAccessPath(returnTo);

  const bindings = env as unknown as {
    ACCESS_CUSTOM_LOGIN_ENABLED?: string;
    OPENFLOOR_TEST_ACCESS_LOGIN_HTML?: string;
  };
  // Someone can always navigate here directly with the flag off (a stale
  // link, a bookmark) — bounce straight to the real protected path so
  // Cloudflare's own (branded) page takes over, same as before this existed.
  if (bindings.ACCESS_CUSTOM_LOGIN_ENABLED !== "true") {
    redirect(destination);
  }

  const teamDomain = normalizedTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const target = await fetchAccessLoginTarget(`https://app.opnflr.com${destination}`, teamDomain, {
    testHtml: bindings.OPENFLOOR_TEST_ACCESS_LOGIN_HTML,
  });
  if (!target.ok) {
    redirect(destination);
  }

  return (
    <main className="entry-shell signin-shell">
      <EntryReplay />
      <div className="entry-backdrop entry-anim">
        <div className="entry-glow" aria-hidden="true" />
        <ParallaxLayer>
          <WaveField />
        </ParallaxLayer>
        <div className="entry-grain" aria-hidden="true" />
      </div>
      <div className="entry-card signin-card">
        <SignInMark />
        {/* GitHub is the primary path. A plain link into Access's own picker,
            not a proxied flow — its OAuth callback needs a CF_Session cookie
            only a direct browser visit to the team domain can carry (see
            lib/access-login.ts's header comment). With GitHub the sole IdP on
            the Access app and instant auth on, this lands straight on
            GitHub's authorize screen. */}
        <a className="signin-button signin-oauth" href={destination}>Continue with GitHub</a>
        <div className="signin-divider" role="separator" aria-label="or">or</div>
        {/* Email one-time code stays as the universal fallback: accounts key
            on email, so this always reaches the account no matter which
            method created it. */}
        <form className="signin-email-form" method="POST" action={`/signin/code?return_to=${encodeURIComponent(destination)}`}>
          <input type="hidden" name="action" value={target.emailAction} />
          <label className="sr-only" htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            className="signin-input"
            type="email"
            name="email"
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
          <button className="signin-button" data-variant="quiet" type="submit">Email me a code</button>
        </form>
      </div>
    </main>
  );
}

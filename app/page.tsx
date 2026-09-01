import { env } from "cloudflare:workers";
import { accessSignInPath, earlyAccessPath, getAccessUser, safeAppReturnPath } from "./access-auth";
import { upsertUser } from "@/db/sessions";
import { earlyAccessGateEnabled, hasEarlyAccess } from "@/lib/early-access";
import { BASE_PATH } from "@/components/basePath";
import { EntryReplay } from "./entry-replay";
import { ParallaxLayer } from "./entry-parallax";
import { WaveField } from "./entry-wave";

export const dynamic = "force-dynamic";

// The mark IS the sign-in control — the only brand mark and the only text
// on the page, so nothing duplicates. At rest it's the same brackets +
// three dots as everywhere else (each bracket its own small SVG, split from
// the single viewBox="0 0 23 8" mark so the two halves can move
// independently). On hover/focus they separate, the dots fade, and
// "open the floor" fades into the gap they left.
function SignInMark({ href, label }: { href: string; label: string }) {
  return (
    <a className="entry-signin" href={href} aria-label={label}>
      <svg className="entry-signin-bracket entry-anim" viewBox="0 0 3 8" aria-hidden="true">
        <path fill="currentColor" d="M0 0h1v7h2v1H0Z" />
      </svg>
      <span className="entry-signin-gap">
        <span className="entry-signin-dots" aria-hidden="true">
          <span className="entry-signin-dot entry-anim" style={{ background: "#2F6DF0" }} />
          <span className="entry-signin-dot entry-anim" style={{ background: "#12A594" }} />
          <span className="entry-signin-dot entry-anim" style={{ background: "#E0457F" }} />
        </span>
        <span className="entry-signin-text" aria-hidden="true">open the floor</span>
      </span>
      <svg className="entry-signin-bracket entry-anim" viewBox="0 0 3 8" aria-hidden="true">
        <path fill="currentColor" d="M3 0h-1v7h-2v1h3Z" />
      </svg>
    </a>
  );
}

export default async function LandingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getAccessUser();
  const params = await searchParams;
  const authRequired = params.auth === "required" && !user;
  const returnTo = safeAppReturnPath(params.return_to);
  // Signed out, the mark must enter the sign-in flow carrying the return
  // target — pointing straight at the target looped back here now that page
  // paths sit outside Access and can't start a login themselves.
  const target = returnTo ?? "/home";
  const appUser = user ? await upsertUser(user) : null;
  const gateEnabled = earlyAccessGateEnabled(env as unknown as Record<string, string | undefined>);
  const admitted = Boolean(appUser && (!gateEnabled || hasEarlyAccess(appUser)));
  const primaryHref = admitted
    ? `${BASE_PATH}/home`
    : gateEnabled
      ? earlyAccessPath(target)
      : accessSignInPath(target);
  return (
    <main className="entry-shell">
      <EntryReplay />
      <div className="entry-backdrop entry-anim">
        <div className="entry-glow" aria-hidden="true" />
        <ParallaxLayer>
          <WaveField />
        </ParallaxLayer>
        <div className="entry-grain" aria-hidden="true" />
      </div>
      <div className="entry-card">
        <SignInMark href={primaryHref} label={admitted ? "Open your sessions" : gateEnabled ? "Request early access" : "Sign in"} />
        {authRequired && (
          <>
            <p className="entry-note entry-anim" role="status">
              Sign in to continue. You will be sent back to what you were opening.
            </p>
            {/* The bracket mark is also the sign-in link, but nobody guesses
                that mid-bounce — the notice carries an explicit button. */}
            <a className="button entry-anim" data-variant="primary" href={primaryHref}>Continue</a>
          </>
        )}
      </div>
    </main>
  );
}

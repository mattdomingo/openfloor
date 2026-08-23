import { accessSignInPath, getAccessUser, safeAppReturnPath } from "./access-auth";
import { BASE_PATH } from "@/components/basePath";
import { ParallaxLayer } from "./entry-parallax";
import { WaveField } from "./entry-wave";

export const dynamic = "force-dynamic";

// The mark IS the sign-in control — no separate button, so the brand mark
// never duplicates itself on the page. At rest it's the same brackets +
// three dots as everywhere else (each bracket its own small SVG, split from
// the single viewBox="0 0 23 8" mark so the two halves can move
// independently). On hover/focus they separate and "open the floor" fades
// in where the dots were.
function SignInMark({ href, label }: { href: string; label: string }) {
  return (
    <a className="entry-signin" href={href} aria-label={label}>
      <svg className="entry-signin-bracket" viewBox="0 0 3 8" aria-hidden="true">
        <path fill="currentColor" d="M0 0h1v7h2v1H0Z" />
      </svg>
      <span className="entry-signin-gap">
        <span className="entry-signin-dots" aria-hidden="true">
          <span className="entry-signin-dot" style={{ background: "#2F6DF0" }} />
          <span className="entry-signin-dot" style={{ background: "#12A594" }} />
          <span className="entry-signin-dot" style={{ background: "#E0457F" }} />
        </span>
        <span className="entry-signin-text" aria-hidden="true">open the floor</span>
      </span>
      <svg className="entry-signin-bracket" viewBox="0 0 3 8" aria-hidden="true">
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
  const primaryHref = user ? `${BASE_PATH}/home` : returnTo ?? accessSignInPath("/home");
  return (
    <main className="entry-shell">
      <div className="entry-backdrop">
        <div className="entry-glow" aria-hidden="true" />
        <ParallaxLayer>
          <WaveField />
        </ParallaxLayer>
        <div className="entry-grain" aria-hidden="true" />
      </div>
      <div className="entry-card">
        <SignInMark href={primaryHref} label={user ? "Open your sessions" : "Sign in"} />
        <p className="entry-wordmark">openfloor</p>
        {authRequired && (
          <p className="entry-note" role="status">
            Sign in to continue. You will be sent back to what you were opening.
          </p>
        )}
      </div>
    </main>
  );
}

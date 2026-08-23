import { accessSignInPath, getAccessUser, safeAppReturnPath } from "./access-auth";
import { BASE_PATH } from "@/components/basePath";

export const dynamic = "force-dynamic";

// Exact geometry of the mark used at opnflr.com (viewBox 0 0 23 8, confirmed
// against its live SVG) — drawn here rather than reusing the flat
// openfloor-mark.png so the dots can animate in individually.
function BrandMark() {
  return (
    <svg className="entry-mark" viewBox="0 0 23 8" aria-hidden="true">
      <path fill="currentColor" d="M0 0h1v7h2v1H0Z" />
      <path fill="currentColor" d="M23 0h-1v7h-2v1h3Z" />
      <circle className="entry-mark-dot" cx="6.5" cy="5.5" r="1.5" fill="#2F6DF0" />
      <circle className="entry-mark-dot" cx="11.5" cy="5.5" r="1.5" fill="#12A594" />
      <circle className="entry-mark-dot" cx="16.5" cy="5.5" r="1.5" fill="#E0457F" />
    </svg>
  );
}

// A faint echo of the marketing hero's animated diagram (translucent panels,
// connecting lines) — static and low-opacity, just enough so the black
// canvas reads as engineered depth rather than a flat void.
function EntryTexture() {
  return (
    <svg className="entry-texture" viewBox="0 0 800 600" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
      <rect x="560" y="120" width="140" height="90" />
      <rect x="600" y="150" width="140" height="90" />
      <rect x="520" y="330" width="120" height="76" />
      <path d="M0 260h180M0 300h140M0 340h160" />
      <path d="M180 260 560 165M140 300 560 195M160 340 520 368" />
    </svg>
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
      <div className="entry-glow" aria-hidden="true" />
      <EntryTexture />
      <div className="entry-grain" aria-hidden="true" />
      <div className="entry-card">
        <BrandMark />
        <p className="entry-wordmark">openfloor</p>
        {authRequired && (
          <p className="entry-note" role="status">
            Sign in to continue. You will be sent back to what you were opening.
          </p>
        )}
        <a className="button" data-variant="primary" href={primaryHref}>
          {user ? "Open your sessions" : "Sign in"}
        </a>
        <p className="entry-hint">Continue with Google or a one-time code sent to your email.</p>
      </div>
    </main>
  );
}

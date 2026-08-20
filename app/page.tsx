import { accessSignInPath, getAccessUser, safeAppReturnPath } from "./access-auth";
import { BASE_PATH } from "@/components/basePath";

export const dynamic = "force-dynamic";

export default async function LandingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getAccessUser();
  const params = await searchParams;
  const authRequired = params.auth === "required" && !user;
  const returnTo = safeAppReturnPath(params.return_to);
  const primaryHref = user ? `${BASE_PATH}/home` : returnTo ?? accessSignInPath("/home");
  return (
    <main className="entry-shell">
      <div className="entry-mesh" aria-hidden="true">
        <div className="entry-blob entry-blob-a" />
        <div className="entry-blob entry-blob-b" />
        <div className="entry-blob entry-blob-c" />
      </div>
      <div className="entry-grain" aria-hidden="true" />
      <div className="entry-vignette" aria-hidden="true" />
      <div className="entry-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- static product mark */}
        <img className="entry-mark" src={`${BASE_PATH}/openfloor-mark.png`} alt="" aria-hidden="true" />
        <p className="entry-wordmark">openfloor</p>
        {authRequired && (
          <p className="entry-note" role="status">
            Sign in to continue. You will be sent back to what you were opening.
          </p>
        )}
        <a className="button" data-variant="primary" data-size="lg" href={primaryHref}>
          {user ? "Open your sessions" : "Sign in"}
        </a>
        <p className="entry-hint">Continue with Google or a one-time code sent to your email.</p>
      </div>
    </main>
  );
}

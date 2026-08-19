import { accessSignInPath, getAccessUser } from "./access-auth";
import { BASE_PATH } from "@/components/basePath";
import { Brand } from "@/components/product/Brand";

export const dynamic = "force-dynamic";

export default async function LandingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getAccessUser();
  const params = await searchParams;
  const authRequired = params.auth === "required" && !user;
  const returnToParam = params.return_to;
  // access-auth already app-prefixes and sanitizes return_to; re-check shape anyway.
  const returnTo = typeof returnToParam === "string" && returnToParam.startsWith("/") && !returnToParam.startsWith("//") ? returnToParam : null;
  const primaryHref = user ? `${BASE_PATH}/home` : returnTo ?? accessSignInPath("/home");
  return (
    <main className="landing-shell">
      <header className="public-nav">
        <Brand />
        <a className="button" data-variant="primary" href={primaryHref}>
          {user ? "Open your sessions" : "Sign in"}
        </a>
      </header>
      <section className="landing-main">
        <p className="eyebrow">A persistent session for agent teams</p>
        <h1>Build together without losing the thread.</h1>
        <p className="landing-copy">
          OpenFloor gives a team one durable session for its objective, members, live presence, and connected
          repository.
        </p>
        {authRequired && <p className="landing-auth-note" role="status">Sign in to open that page. You will be sent back to it. Sign-in happens on a Cloudflare Access screen — continue with Google or a one-time code sent to your email.</p>}
        <div className="landing-actions">
          <a className="button" data-variant="primary" data-size="lg" href={primaryHref}>
            {user ? "Go to your sessions" : "Sign in"}
          </a>
          <span>No new password. Sign in with your email or a Google account.</span>
        </div>
      </section>
      <section className="landing-proof" aria-label="Product principles">
        <article><strong>Persistent</strong><p>Sessions and membership survive refreshes, devices, and reconnects.</p></article>
        <article><strong>Present</strong><p>See who is in the session now, with instant join and leave updates.</p></article>
        <article><strong>Private</strong><p>Only authenticated members can open a session or its live connection.</p></article>
      </section>
    </main>
  );
}

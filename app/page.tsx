import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import { BASE_PATH } from "@/components/basePath";
import { Brand } from "@/components/product/Brand";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const user = await getChatGPTUser();
  const primaryHref = user ? `${BASE_PATH}/home` : chatGPTSignInPath("/home");
  return (
    <main className="landing-shell">
      <header className="public-nav">
        <Brand />
        <a className="button" data-variant="primary" href={primaryHref}>
          {user ? "Open your sessions" : "Sign in with ChatGPT"}
        </a>
      </header>
      <section className="landing-main">
        <p className="eyebrow">A persistent room for agent teams</p>
        <h1>Build together without losing the thread.</h1>
        <p className="landing-copy">
          OpenFloor gives a team one durable session for its objective, members, and live presence—ready for the agent
          work that comes next.
        </p>
        <div className="landing-actions">
          <a className="button" data-variant="primary" data-size="lg" href={primaryHref}>
            {user ? "Go to your sessions" : "Continue with ChatGPT"}
          </a>
          <span>No new password. Your ChatGPT identity stays the source of truth.</span>
        </div>
      </section>
      <section className="landing-proof" aria-label="Product principles">
        <article><strong>Persistent</strong><p>Sessions and membership survive refreshes, devices, and reconnects.</p></article>
        <article><strong>Present</strong><p>See who is in the room now, with instant join and leave updates.</p></article>
        <article><strong>Private</strong><p>Only authenticated members can open a session or its live connection.</p></article>
      </section>
    </main>
  );
}

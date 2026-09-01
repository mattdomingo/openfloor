import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { accessSignInPath, safeAppReturnPath } from "@/lib/access-paths";
import { earlyAccessGateEnabled, hasEarlyAccess } from "@/lib/early-access";
import { getCurrentAppUser } from "@/lib/server-auth";
import { EntryReplay } from "../entry-replay";
import { ParallaxLayer } from "../entry-parallax";
import { WaveField } from "../entry-wave";

export const dynamic = "force-dynamic";

export default async function EarlyAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const returnTo = safeAppReturnPath(params.return_to) ?? `${BASE_PATH}/home`;
  const user = await getCurrentAppUser();
  const gateEnabled = earlyAccessGateEnabled(env as unknown as Record<string, string | undefined>);
  if (user && (!gateEnabled || hasEarlyAccess(user))) redirect(`${BASE_PATH}/home`);

  const waitlistJoined = params.waitlist === "joined";
  const unlockError = params.unlock === "invalid"
    ? "That beta passcode was not recognized."
    : params.unlock === "revoked"
      ? "Early access for this account was revoked. Contact hello@opnflr.com if you believe this is a mistake."
      : params.unlock === "expired"
        ? "That admission link expired. Enter the beta passcode again."
        : null;
  const completePath = `${BASE_PATH}/early-access/complete?return_to=${encodeURIComponent(returnTo)}`;

  return (
    <main className="entry-shell early-access-shell">
      <EntryReplay />
      <div className="entry-backdrop entry-anim">
        <div className="entry-glow" aria-hidden="true" />
        <ParallaxLayer><WaveField /></ParallaxLayer>
        <div className="entry-grain" aria-hidden="true" />
      </div>
      <section className="early-access-card entry-anim" aria-labelledby="early-access-title">
        <header className="early-access-heading">
          <p className="early-access-kicker">Private beta</p>
          <h1 id="early-access-title">Help shape the agent floor.</h1>
          <p>openfloor is opening in small groups while we finish the experience. Join the waitlist, or use the passcode from your beta invitation.</p>
        </header>

        <div className="early-access-grid">
          <form className="early-access-form" method="POST" action={`${BASE_PATH}/early-access/waitlist`}>
            <input type="hidden" name="return_to" value={returnTo} />
            <div>
              <p className="early-access-form-label">Join the waitlist</p>
              <p className="early-access-form-copy">We’ll contact you as beta spots become available.</p>
            </div>
            {waitlistJoined && <p className="early-access-notice" role="status">You’re on the list. We’ll be in touch.</p>}
            <label htmlFor="early-access-name">Name</label>
            <input id="early-access-name" className="signin-input" name="name" type="text" autoComplete="name" maxLength={100} required />
            <label htmlFor="early-access-email">Email</label>
            <input id="early-access-email" className="signin-input" name="email" type="email" autoComplete="email" maxLength={254} required />
            <p className="early-access-disclosure">By joining, you agree to receive waitlist status, beta invitations, and essential beta updates from openfloor. This does not include general marketing. Request removal at <a href="mailto:hello@opnflr.com">hello@opnflr.com</a>.</p>
            <button className="signin-button" type="submit">Join the waitlist</button>
          </form>

          <form className="early-access-form" method="POST" action={`${BASE_PATH}/early-access/unlock`}>
            <input type="hidden" name="return_to" value={returnTo} />
            <div>
              <p className="early-access-form-label">Beta tester access</p>
              <p className="early-access-form-copy">Enter the shared passcode from your invitation.</p>
            </div>
            {unlockError && <p className="early-access-error" role="alert">{unlockError}</p>}
            <label htmlFor="early-access-passcode">Beta passcode</label>
            <input id="early-access-passcode" className="signin-input" name="passcode" type="password" autoComplete="current-password" maxLength={256} required />
            <button className="signin-button" type="submit">Unlock early access</button>
            <p className="early-access-existing">Already have access? <a href={accessSignInPath(completePath)}>Sign in</a></p>
          </form>
        </div>
      </section>
    </main>
  );
}

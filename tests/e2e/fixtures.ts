import type { Browser, BrowserContext, Page } from "@playwright/test";

/** The first-visit guided tour overlays real controls; specs that aren't
    about the tour dismiss it before touching the grid. */
export async function skipTourIfOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) => value.startsWith("openfloor:tutorial:home:"));
    if (key) window.dispatchEvent(new CustomEvent("openfloor:tour-complete", { detail: key }));
  });
}

export function identityHeaders(id: string, email: string, name: string) {
  return {
    "x-openfloor-dev-user-id": id,
    "x-openfloor-dev-user-email": email,
    "x-openfloor-dev-user-name": name,
  };
}

export async function authenticatedContext(browser: Browser, id: string, email: string, firstName: string, lastName: string): Promise<BrowserContext> {
  const context = await browser.newContext({ extraHTTPHeaders: identityHeaders(id, email, `${firstName} ${lastName}`) });
  await context.request.patch("/api/account/onboarding", { multipart: { firstName, lastName, githubHandle: "" } });
  const begun = await context.request.post("/api/account/github/connect", { data: { purpose: "onboarding", returnTo: "/home" } });
  const { installUrl } = await begun.json() as { installUrl: string };
  const callback = await context.request.get(installUrl, { maxRedirects: 0 });
  if (callback.status() !== 303) throw new Error(`Test GitHub callback failed with ${callback.status()}`);
  await context.request.post("/api/account/onboarding", { multipart: { firstName, lastName, plan: "free", returnTo: "/home" } });

  // Mark the first-visit guided tour (components/GuidedTour.tsx) as seen so
  // its bubble never intercepts a click mid-flow; the tour's own behavior is
  // per-device UI, not the collaboration under test here. Its storage key is
  // suffixed with the account's internal id, not the provider id passed in
  // above, so read it back from bootstrap once onboarding is done.
  const bootstrap = await context.request.get("/api/bootstrap/home");
  const { props } = await bootstrap.json() as { props: { user: { id: string } } };
  await context.addInitScript((userId: string) => {
    try {
      localStorage.setItem(`openfloor:tutorial:home:${userId}`, "done");
      localStorage.setItem(`openfloor:tutorial:floor:${userId}`, "done");
    } catch {
      // Storage unavailable: the tour stays closed in that case anyway.
    }
  }, props.user.id);
  return context;
}

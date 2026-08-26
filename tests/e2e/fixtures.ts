import type { Browser, BrowserContext } from "@playwright/test";

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
  return context;
}

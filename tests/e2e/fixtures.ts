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
  // Every protected page redirects to /onboarding until first/last name are set, so
  // complete it here rather than in each test.
  await context.request.post("/app/api/account/onboarding", { multipart: { firstName, lastName } });
  return context;
}

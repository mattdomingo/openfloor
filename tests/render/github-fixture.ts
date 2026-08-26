import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export async function completeTestOnboarding(
  headers: Record<string, string>,
  firstName: string,
  lastName: string,
  returnTo = "/home",
) {
  const profile = new FormData();
  profile.set("firstName", firstName);
  profile.set("lastName", lastName);
  profile.set("githubHandle", "");
  expect((await SELF.fetch("http://localhost/api/account/onboarding", { method: "PATCH", headers, body: profile })).status).toBe(200);
  const begun = await SELF.fetch("http://localhost/api/account/github/connect", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "onboarding", returnTo }),
  });
  expect(begun.status).toBe(200);
  const { installUrl } = await begun.json() as { installUrl: string };
  expect((await SELF.fetch(new URL(installUrl, "http://localhost"), { headers, redirect: "manual" })).status).toBe(303);
  const form = new FormData();
  form.set("firstName", firstName);
  form.set("lastName", lastName);
  form.set("plan", "free");
  form.set("returnTo", returnTo);
  expect((await SELF.fetch("http://localhost/api/account/onboarding", { method: "POST", headers, body: form })).status).toBe(200);
}

export async function testRepositorySelection(headers: Record<string, string>) {
  const response = await SELF.fetch("http://localhost/api/account/github/repositories", { headers });
  expect(response.status).toBe(200);
  const { repositories } = await response.json() as { repositories: Array<{ id: string; accountInstallationId: string }> };
  if (!repositories[0]) throw new Error("Test GitHub installation has no repository");
  return { repositoryId: repositories[0].id, accountInstallationId: repositories[0].accountInstallationId };
}

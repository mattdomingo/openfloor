import { expect, test } from "@playwright/test";
import { authenticatedContext } from "./fixtures";

type RepositoryOption = { id: string; accountInstallationId: string };

async function repositories(context: Awaited<ReturnType<typeof authenticatedContext>>): Promise<RepositoryOption[]> {
  const response = await context.request.get("/api/account/github/repositories");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { repositories: RepositoryOption[] }).repositories;
}

test("Settings removes and restores account GitHub access without changing an existing session", async ({ browser }) => {
  const context = await authenticatedContext(browser, "github-settings", "github-settings@example.com", "GitHub", "Settings");
  const [repository] = await repositories(context);
  const created = await context.request.post("/api/sessions", {
    data: {
      title: "Preserved GitHub session",
      repositoryId: repository.id,
      accountInstallationId: repository.accountInstallationId,
    },
  });
  expect(created.status()).toBe(201);
  const sessionId = ((await created.json()) as { session: { id: string } }).session.id;

  const page = await context.newPage();
  await page.goto("/home/settings?section=connections");
  const installationRow = page.locator("li.settings-category-row", { hasText: "openfloor-test" })
    .filter({ has: page.getByRole("button", { name: "Remove", exact: true }) });
  await expect(installationRow).toBeVisible();
  await installationRow.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(installationRow).toHaveCount(0);

  const preserved = await context.request.get(`/api/sessions/${sessionId}/repository`);
  expect(preserved.ok()).toBe(true);
  expect(((await preserved.json()) as { repository: { status: string } }).repository.status).toBe("ready");

  const blocked = await context.request.post("/api/sessions", {
    data: {
      title: "Blocked until GitHub returns",
      repositoryId: repository.id,
      accountInstallationId: repository.accountInstallationId,
    },
  });
  expect(blocked.status()).toBe(409);
  await expect(blocked.json()).resolves.toEqual(expect.objectContaining({ code: "github_required" }));

  await page.getByRole("button", { name: "Add GitHub access" }).click();
  await expect(page).toHaveURL(/\/home\/settings\?section=connections&github=connected$/);
  await expect(page.locator("li.settings-category-row", { hasText: "openfloor-test" })
    .filter({ has: page.getByRole("button", { name: "Remove", exact: true }) })).toBeVisible();
  expect((await repositories(context)).length).toBeGreaterThan(0);

  await context.close();
});

test("session creation rejects another user's opaque GitHub association", async ({ browser }) => {
  const owner = await authenticatedContext(browser, "github-association-owner", "github-association-owner@example.com", "Association", "Owner");
  const outsider = await authenticatedContext(browser, "github-association-outsider", "github-association-outsider@example.com", "Association", "Outsider");
  const [ownerRepository] = await repositories(owner);

  const response = await outsider.request.post("/api/sessions", {
    data: {
      title: "Cross-user association",
      repositoryId: ownerRepository.id,
      accountInstallationId: ownerRepository.accountInstallationId,
    },
  });
  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({
    error: "Repository is not available to this GitHub account installation",
  }));

  await owner.close();
  await outsider.close();
});

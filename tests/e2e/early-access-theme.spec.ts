import { expect, test } from "@playwright/test";

const cases = [
  { name: "System on a light desktop", theme: null, os: "light", width: 1280, height: 900, expected: "light", columns: 2 },
  { name: "System on a dark phone", theme: null, os: "dark", width: 390, height: 844, expected: "dark", columns: 1 },
  { name: "Light on a dark phone", theme: "light", os: "dark", width: 390, height: 844, expected: "light", columns: 1 },
  { name: "Stone on a dark desktop", theme: "stone", os: "dark", width: 1280, height: 900, expected: "light", columns: 2 },
  { name: "Dark on a light desktop", theme: "dark", os: "light", width: 1280, height: 900, expected: "dark", columns: 2 },
  { name: "Charcoal on a light phone", theme: "charcoal", os: "light", width: 390, height: 844, expected: "dark", columns: 1 },
] as const;

function colorChannels(value: string): number[] {
  return value.match(/[\d.]+/g)?.map(Number) ?? [];
}

test("early-access colors stay consistent with every theme on mobile and desktop", async ({ browser }) => {
  for (const scenario of cases) {
    const context = await browser.newContext({
      colorScheme: scenario.os,
      viewport: { width: scenario.width, height: scenario.height },
    });
    await context.addInitScript((theme: string | null) => {
      if (theme) localStorage.setItem("openfloor:theme", theme);
      else localStorage.removeItem("openfloor:theme");
    }, scenario.theme);
    const page = await context.newPage();

    await test.step(scenario.name, async () => {
      await page.goto("/early-access?waitlist=joined&unlock=invalid");
      await expect(page.getByRole("heading", { name: "Help shape the agent floor." })).toBeVisible();

      const appearance = await page.locator(".early-access-shell").evaluate((shell) => {
        const style = (selector: string) => getComputedStyle(document.querySelector<HTMLElement>(selector)!);
        return {
          rootTheme: document.documentElement.dataset.theme ?? null,
          colorScheme: getComputedStyle(shell).colorScheme,
          cardBackground: style(".early-access-card").backgroundColor,
          cardColor: style(".early-access-card").color,
          formBackground: style(".early-access-form").backgroundColor,
          noticeColor: style(".early-access-notice").color,
          errorColor: style(".early-access-error").color,
          columns: style(".early-access-grid").gridTemplateColumns.split(" ").length,
          overflows: document.documentElement.scrollWidth > window.innerWidth,
        };
      });

      expect(appearance.rootTheme).toBe(scenario.theme);
      expect(appearance.colorScheme).toBe(scenario.expected);
      expect(appearance.columns).toBe(scenario.columns);
      expect(appearance.overflows).toBe(false);

      const card = colorChannels(appearance.cardBackground);
      const ink = colorChannels(appearance.cardColor);
      const form = colorChannels(appearance.formBackground);
      const notice = colorChannels(appearance.noticeColor);
      const error = colorChannels(appearance.errorColor);
      if (scenario.expected === "light") {
        expect(Math.min(...card.slice(0, 3))).toBeGreaterThan(220);
        expect(Math.max(...ink.slice(0, 3))).toBeLessThan(50);
        expect(form[3]).toBeGreaterThan(0.5);
        expect(Math.max(...notice.slice(0, 3))).toBeLessThan(120);
        expect(Math.max(...error.slice(0, 3))).toBeLessThan(180);
      } else {
        expect(Math.max(...card.slice(0, 3))).toBeLessThan(40);
        expect(Math.min(...ink.slice(0, 3))).toBeGreaterThan(190);
        expect(form[3]).toBeLessThan(0.1);
        expect(Math.min(...notice.slice(0, 3))).toBeGreaterThan(170);
        expect(Math.min(...error.slice(0, 3))).toBeGreaterThan(180);
      }
    });

    await context.close();
  }
});

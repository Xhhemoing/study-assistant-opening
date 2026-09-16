import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("keeps Learn, Explore, and Library available across viewport sizes", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
      data: userInput("navigation-user"),
    });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    for (const viewport of [
      { width: 320, height: 800 },
      { width: 768, height: 900 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/learn");
      const visibleNavigation = page.locator('nav[aria-label="Workspace navigation"]:visible');
      await expect(visibleNavigation).toBeVisible();
      await expect(visibleNavigation.locator('a[href="/learn"]')).toBeVisible();
      await expect(visibleNavigation.locator('a[href="/explore"]')).toBeVisible();
      await expect(visibleNavigation.locator('a[href="/library"]')).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    }

    const visibleNavigation = page.locator('nav[aria-label="Workspace navigation"]:visible');
    await visibleNavigation.locator('a[href="/explore"]').click();
    await expect(page).toHaveURL(/\/explore$/);
    await page.reload();
    await expect(page).toHaveURL(/\/explore$/);
  } finally {
    await context.close();
  }
});

test("persists an onboarding choice on the server and redirects the workspace root", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
      data: userInput("persisted-default"),
    });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "自由探索" }).click();
    await expect(page).toHaveURL(/\/explore$/);

    await page.evaluate(() => window.localStorage.clear());
    await page.goto("/");
    await expect(page).toHaveURL(/\/explore$/);
  } finally {
    await context.close();
  }
});

test("falls back to Learn when an authenticated workspace has no preference", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
      data: userInput("default-learn"),
    });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/learn$/);
  } finally {
    await context.close();
  }
});
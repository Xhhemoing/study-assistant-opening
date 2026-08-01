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
    const registered = await context.request.post("/api/auth/register", {
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
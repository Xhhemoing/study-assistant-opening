import { expect, test } from "@playwright/test";

test.describe("real web server", () => {
  for (const viewport of [
    { width: 320, height: 800 },
    { width: 768, height: 900 },
    { width: 1440, height: 1000 },
  ]) {
    test(`serves the unauthenticated entry page at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/login");
      await expect(page).toHaveTitle("AIstudy");
      await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    });
  }
});
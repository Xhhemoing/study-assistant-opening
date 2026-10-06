import { expect, test } from "@playwright/test";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

test.describe("opening shell", () => {
  test.beforeAll(async () => {
    await seedOpeningOwner();
  });

  test("shows the three responsive entry points", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto("/opening/today");
        await expect(
          page.getByRole("navigation", { name: "学习工作台导航" }),
        ).toBeVisible();
        await expect(page.getByRole("navigation", { name: "学习工作台导航" }).getByRole("link", { name: "今日" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "学习工作台导航" }).getByRole("link", { name: "助理" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "学习工作台导航" }).getByRole("link", { name: "课程" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "学习工作台导航" }).getByRole("link", { name: "今日" })).toHaveAttribute(
          "aria-current",
          "page",
        );
        // Carried over from the retired workspace-navigation spec: the shell
        // must not introduce horizontal overflow at any viewport width.
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      }
    } finally {
      await context.close();
    }
  });

  test("today page shows an honest empty state instead of fabricated data", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/opening/today");
      // Today is now a dashboard (queue + embedded assistant); a fresh owner sees the neutral start prompt, not fabricated progress.
      await expect(page.getByRole("heading", { name: "今日学习工作台", exact: true })).toBeAttached();
      await expect(page.getByText("从一个问题、一次练习或一篇笔记开始", { exact: true })).toBeVisible();
      await expect(page.getByText(/^上次学习：/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "课程与自主练习", exact: true })).toHaveAttribute("href", "/opening/courses");
    } finally {
      await context.close();
    }
  });

  test("supports keyboard navigation into the entry points", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/opening/today");
      const today = page.getByRole("navigation", { name: "学习工作台导航" }).getByRole("link", { name: "今日" });
      await today.focus();
      await expect(today).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("navigation", { name: "学习工作台导航" }).getByRole("link", { name: "助理" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/opening\/assistant$/);
    } finally {
      await context.close();
    }
  });

  test("requires login for the opening shell", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await page.goto("/opening/today");
      await expect(page).toHaveURL(/\/login\?returnTo=%2Fopening%2Ftoday$/);
    } finally {
      await context.close();
    }
  });
});

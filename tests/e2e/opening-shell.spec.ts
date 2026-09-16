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
          page.getByRole("navigation", { name: "Opening navigation" }),
        ).toBeVisible();
        await expect(page.getByRole("link", { name: "今日" })).toBeVisible();
        await expect(page.getByRole("link", { name: "助理" })).toBeVisible();
        await expect(page.getByRole("link", { name: "课程" })).toBeVisible();
        await expect(page.getByRole("link", { name: "今日" })).toHaveAttribute(
          "aria-current",
          "page",
        );
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
      await expect(page.getByText("今天还没有学习任务")).toBeVisible();
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
      const today = page.getByRole("link", { name: "今日" });
      await today.focus();
      await expect(today).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "助理" })).toBeFocused();
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
      await expect(page).toHaveURL(/\/login$/);
    } finally {
      await context.close();
    }
  });
});

import { expect, test, type BrowserContext } from "@playwright/test";
import { isOpeningReleaseEnabled } from "./opening-auth";

async function register(context: BrowserContext, label: string) {
  const response = await context.request.post("/api/auth/register", { headers: { origin: "http://127.0.0.1:3000" },
    data: {
      email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "password123",
      displayName: label,
    },
  });
  expect(response.status()).toBe(201);
}

async function expectOpeningTodaySurface(page: import("@playwright/test").Page) {
  // sr-only h1 on TodayDashboard — stable closed-loop marker
  await expect(page.getByRole("heading", { name: "今日学习工作台", exact: true })).toBeAttached();
  await expect(page.locator('[data-today-loop-links="true"]')).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "学习工作台导航" }).getByRole("link", { name: "今日" }),
  ).toBeVisible();
}

test("opening today shows closed-loop workbench after register", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "today-plan");
    const page = await context.newPage();
    // Closed-loop surface: do not depend on legacy /learn 「今日任务」 + 跳过 mock.
    await page.goto("/opening/today");
    await expectOpeningTodaySurface(page);
    await expect(page.getByText("从一个问题、一次练习或一篇笔记开始", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("legacy learn paths yield to opening today under closed-loop", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "today-plan-options");
    const page = await context.newPage();

    if (isOpeningReleaseEnabled()) {
      // Middleware redirects /learn and /learn/goals/* → /opening/today
      await page.goto("/learn");
      await expect(page).toHaveURL(/\/opening\/today/);
      await expectOpeningTodaySurface(page);

      await page.goto("/learn/goals/new");
      await expect(page).toHaveURL(/\/opening\/today/);
      await expectOpeningTodaySurface(page);
    } else {
      // Default playwright.config does not set OPENING_RELEASE — assert the
      // supported closed-loop surface directly; do not require legacy conflict wizard.
      await page.goto("/opening/today");
      await expectOpeningTodaySurface(page);
    }

    await expect(page.getByRole("heading", { name: "选择今天的安排" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

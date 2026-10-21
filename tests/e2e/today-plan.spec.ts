import { expect, test, type BrowserContext } from "./fixtures";
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

async function expectOpeningTodayEmptySurface(page: import("@playwright/test").Page) {
  await expect(page.getByRole("heading", { name: "今日学习工作台", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "从第一门课程开始", exact: true })).toBeVisible();
  const start = page.getByRole("link", { name: "添加第一门课", exact: true });
  await expect(start).toBeVisible();
  await expect(start).toHaveAttribute("href", "/opening/courses/new");
  await expect(page.getByRole("article", { name: "继续学习", exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "学习闭环快捷入口", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "学习工作台导航" }).getByRole("link", { name: "今日" }),
  ).toBeVisible();
}

test("opening today offers the first course entry after register and restores it on return", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "today-plan");
    const page = await context.newPage();
    // Closed-loop surface: do not depend on legacy /learn 「今日任务」 + 跳过 mock.
    await page.goto("/opening/today");
    await expectOpeningTodayEmptySurface(page);
    await page.getByRole("link", { name: "添加第一门课", exact: true }).click();
    await expect(page).toHaveURL(/\/opening\/courses\/new$/);
    await expect(page.getByRole("heading", { name: "新建课程", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "课程名称", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/opening\/today$/);
    await expectOpeningTodayEmptySurface(page);
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
      await expectOpeningTodayEmptySurface(page);

      await page.goto("/learn/goals/new");
      await expect(page).toHaveURL(/\/opening\/today/);
      await expectOpeningTodayEmptySurface(page);
    } else {
      // Default playwright.config does not set OPENING_RELEASE — assert the
      // supported closed-loop surface directly; do not require legacy conflict wizard.
      await page.goto("/opening/today");
      await expectOpeningTodayEmptySurface(page);
    }

    await expect(page.getByRole("heading", { name: "选择今天的安排" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

import { expect, test, type BrowserContext } from "@playwright/test";

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

test("shows today's plan with task reasons and skip does not mark failure", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "today-plan");
    const page = await context.newPage();
    await page.goto("/learn");
    await expect(page.getByRole("heading", { name: "今日任务" })).toBeVisible();
    await expect(page.getByText(/分钟/).first()).toBeVisible();
    // Reasons live in a collapsed <details>「安排依据」; expand the first one.
    const firstReasonToggle = page.getByText("安排依据").first();
    await firstReasonToggle.click();
    const firstReason = page.locator("ul li details p").first();
    await expect(firstReason).toBeVisible();
    await expect(firstReason).not.toHaveText(/失败/);

    await page.getByRole("button", { name: "跳过" }).first().click();
    await expect(page.getByText("失败")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "今日任务" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("asks the learner to choose a plan when goals conflict", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "today-plan-options");
    const page = await context.newPage();
    await page.goto("/learn");
    await expect(page.getByRole("heading", { name: "今日任务" })).toBeVisible();

    await page.goto("/learn/goals/new");
    // The scenario radio is visually hidden; users click its visible label.
    await page.locator("label", { has: page.getByRole("radio", { name: /高考/ }) }).click();
    await expect(page.getByRole("radio", { name: /高考/ })).toBeChecked();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "创建目标" }).click();
    await expect(page).toHaveURL(/\/learn\/goals\//);

    await page.goto("/learn");
    await expect(page.getByRole("heading", { name: "选择今天的安排" })).toBeVisible();
    await expect(page.getByRole("button", { name: "使用这个安排" })).toBeVisible();
    await page.getByRole("button", { name: "使用这个安排" }).click();
    await expect(page.getByRole("heading", { name: "选择今天的安排" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "开始" }).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

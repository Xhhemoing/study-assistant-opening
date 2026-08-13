import { expect, test, type BrowserContext } from "@playwright/test";

async function register(context: BrowserContext, label: string) {
  const response = await context.request.post("/api/auth/register", {
    data: {
      email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password: "password123",
      displayName: label,
    },
  });
  expect(response.status()).toBe(201);
}

test("starts free exploration without a course or goal (Path A)", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "path-a");
    const page = await context.newPage();
    await page.goto("/onboarding");
    await expect(page.getByText("你想从哪里开始？")).toBeVisible();

    await page.locator('[data-onboarding-path="free-exploration"]').click();
    await expect(page).toHaveURL(/\/explore/);
    await expect(page.getByRole("heading", { name: "自由探索" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("creates a course with a final-exam goal (Path B)", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "path-b");
    const page = await context.newPage();
    await page.goto("/onboarding");
    await page.locator('[data-onboarding-path="goal-course"]').click();
    await expect(page).toHaveURL(/\/learn\/courses\/new/);

    const title = `Goal Course ${Date.now()}`;
    await page.locator("#course-title").fill(title);
    await page.locator("#course-slug").fill(`goal-course-${Date.now()}`);
    await page.getByRole("button", { name: "创建课程" }).click();
    await expect(page).toHaveURL(/\/learn\/courses\//);

    await page.getByRole("link", { name: "添加目标" }).click();
    await expect(page).toHaveURL(/\/learn\/goals\/new\?courseId=/);

    await page.locator("#goal-title").fill("Final Exam Goal");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "创建目标" }).click();
    await expect(page).toHaveURL(/\/learn\/goals\//);
  } finally {
    await context.close();
  }
});

test("promotes an exploration candidate into a new course (Path C)", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "path-c");
    const exploration = await context.request.post("/api/explorations", {
      data: { title: "Promote me" },
    });
    const explorationId = (await exploration.json()).exploration.id as string;
    const promotion = await context.request.post(
      `/api/explorations/${explorationId}/promotions`,
      { data: { kind: "note", title: "Course Seed", body: "Seed body" } },
    );
    expect(promotion.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/onboarding");
    await page.locator('[data-onboarding-path="promote-exploration"]').click();
    await expect(page).toHaveURL(/\/explore/);

    await page.goto(`/explore/${explorationId}`);
    await page.getByRole("button", { name: "转为课程" }).click();
    await expect(page).toHaveURL(/\/learn\/courses\//);
  } finally {
    await context.close();
  }
});

test("creates a knowledge-only course with no plan (Path D)", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "path-d");
    const page = await context.newPage();
    await page.goto("/onboarding");
    await page.locator('[data-onboarding-path="knowledge-course"]').click();
    await expect(page).toHaveURL(/\/learn\/courses\/new/);

    await page.locator("#course-title").fill("Knowledge Only");
    await page.locator("#course-slug").fill(`knowledge-only-${Date.now()}`);
    await page.getByRole("button", { name: "创建课程" }).click();
    await expect(page).toHaveURL(/\/learn\/courses\//);

    await expect(page.getByText("还没有目标。")).toBeVisible();
  } finally {
    await context.close();
  }
});

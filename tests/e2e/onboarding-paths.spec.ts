import { expect, test, type BrowserContext } from "./fixtures";

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

test("creates a knowledge-only course with no plan (Path D)", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    await register(context, "path-d");
    const page = await context.newPage();
    await page.goto("/onboarding");
    await page.getByText("跳过设置，选择其他入口", { exact: true }).click();
    await page.locator('[data-onboarding-path="knowledge-course"]').click();
    await expect(page).toHaveURL(/\/opening\/courses\/new/);

    await page.locator("#course-title").fill("Knowledge Only");
    await page.getByRole("button", { name: "创建课程" }).click();
    await expect(page).toHaveURL(/\/opening\/courses\//);

    // The optional course path stays in the real Opening workspace.
    await expect(page.getByRole("heading", { name: "Knowledge Only" })).toBeVisible();
  } finally {
    await context.close();
  }
});

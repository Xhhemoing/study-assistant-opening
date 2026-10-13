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

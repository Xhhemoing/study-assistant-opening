import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("switches guidance autonomy mode between free, advisory, and coach", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", {
      data: userInput("guidance-mode"),
    });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/settings");

    const coach = page.locator('input[name="guidance-mode"][value="coach"]');
    const free = page.locator('input[name="guidance-mode"][value="free"]');
    const advisory = page.locator('input[name="guidance-mode"][value="advisory"]');

    await expect(advisory).toBeChecked();
    await coach.check();
    await expect(coach).toBeChecked();
    await free.check();
    await expect(free).toBeChecked();
    await expect(advisory).not.toBeChecked();
  } finally {
    await context.close();
  }
});

test("reserves and removes protected exploration time", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", {
      data: userInput("guidance-slot"),
    });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/settings");

    const start = page.getByLabel("开始");
    const end = page.getByLabel("结束");
    await start.fill("18:30");
    await end.fill("19:15");

    await page.getByRole("button", { name: "添加" }).click();
    await expect(page.getByText("18:30 – 19:15")).toBeVisible();

    await page.getByRole("button", { name: "移除 18:30–19:15 预留时段" }).click();
    await expect(page.getByText("18:30 – 19:15")).toHaveCount(0);
    await expect(page.getByText("尚未预留任何探索时段。")).toBeVisible();
  } finally {
    await context.close();
  }
});

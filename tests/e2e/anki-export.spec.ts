import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("exports cards as an Anki projection with a visible loss report", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { data: userInput("anki-export") });
    expect(registered.status()).toBe(201);
    const created = await context.request.post("/api/cards", {
      data: { front: "导数", back: "极限定义", tags: ["高数"] },
    });
    expect(created.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/settings/export");
    await expect(page.getByRole("heading", { name: "数据导出" })).toBeVisible();
    await expect(page.getByRole("button", { name: "导出 Anki" })).toBeVisible();
    await expect(page.getByText("不是完整备份").first()).toBeVisible();
    await expect(page.getByText("无损")).toHaveCount(0);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 Anki" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.txt$/);
    await expect(page.getByRole("status")).toContainText("损失报告");
    await expect(page.getByText("Anki 只是可交换投影，不是完整备份。")).toBeVisible();
    await expect(page.getByText("无损")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

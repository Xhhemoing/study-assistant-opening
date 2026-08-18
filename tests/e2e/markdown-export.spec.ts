import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("exports library notes as Markdown with a visible loss report", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { data: userInput("markdown-export") });
    expect(registered.status()).toBe(201);
    const created = await context.request.post("/api/documents", {
      data: {
        title: "导数笔记",
        blocks: [{ id: crypto.randomUUID(), type: "heading", content: { text: "导数", level: 1 } }],
      },
    });
    expect(created.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/settings/export");
    await expect(page.getByRole("heading", { name: "数据导出" })).toBeVisible();
    await expect(page.getByText("不是完整备份").first()).toBeVisible();
    await expect(page.getByText("无损")).toHaveCount(0);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 Markdown" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    await expect(page.getByRole("status")).toContainText("损失报告");
    await expect(page.getByText("无损")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

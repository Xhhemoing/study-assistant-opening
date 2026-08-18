import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("exports a native workspace backup and shows a non-overwriting restore policy", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { data: userInput("native-backup") });
    expect(registered.status()).toBe(201);
    const created = await context.request.post("/api/documents", {
      data: {
        title: "导数笔记",
        blocks: [{ id: crypto.randomUUID(), type: "paragraph", content: { text: "极限" } }],
      },
    });
    expect(created.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/settings/export");
    await expect(page.getByRole("heading", { name: "完整备份" })).toBeVisible();
    await expect(page.getByRole("button", { name: "导出完整备份" })).toBeVisible();
    await expect(page.getByText("不会覆盖").first()).toBeVisible();
    await expect(page.getByText("拒绝（发现已存在 ID 时整体失败）")).toBeVisible();
    await expect(page.getByText("跳过（保留现有记录，不覆盖）")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出完整备份" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
  } finally {
    await context.close();
  }
});

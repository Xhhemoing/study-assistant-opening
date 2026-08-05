import { expect, test } from "@playwright/test";

test("renders the standalone learning notebook preview and switches into learning mode", async ({ page }) => {
  await page.goto("/preview/notebook");

  await expect(page.getByRole("heading", { name: "概率推理：从贝叶斯公式到决策" })).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑" })).toBeVisible();
  await expect(page.getByRole("button", { name: "阅读" })).toBeVisible();

  await page.getByRole("button", { name: "学习" }).click();

  await expect(page.getByRole("heading", { name: "先用自己的话回答" })).toBeVisible();
  await expect(page.getByRole("button", { name: "显示提示" })).toBeVisible();
});

test("keeps document changes as proposals in the preview", async ({ page }) => {
  await page.goto("/preview/notebook");

  await page.getByRole("button", { name: "AI 助手", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "理解这个章节" })).toBeVisible();
  await expect(page.getByText("只生成候选，不会直接修改笔记。" )).toBeVisible();

  await page.getByRole("button", { name: "生成学习版候选" }).click();
  await expect(page.getByText("已应用的学习版候选")).toBeVisible();
});

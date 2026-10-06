import { expect, test } from "@playwright/test";

test("renders a document-first notebook preview and opens learning mode from page actions", async ({ page }) => {
  await page.goto("/preview/notebook");

  await expect(page.getByRole("heading", { name: "概率推理：从贝叶斯公式到决策" })).toBeVisible();
  await expect(page.getByText("AIstudy", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "分享状态" })).toBeVisible();
  await expect(page.getByLabel("工作区导航")).toHaveCount(0);

  await page.getByRole("button", { name: "更多页面操作" }).click();
  await page.getByRole("button", { name: "体验学习模式" }).click();

  await expect(page.getByRole("heading", { name: "试着用自己的话回答" })).toBeVisible();
  await expect(page.getByRole("button", { name: "显示预设提示" })).toBeVisible();
});

test("keeps document changes as proposals in the preview", async ({ page }) => {
  await page.goto("/preview/notebook");

  await page.getByRole("button", { name: "更多页面操作" }).click();
  await page.getByRole("button", { name: "查看学习版示例" }).click();
  await expect(page.getByText("这是预先编写的学习版示例", { exact: false })).toBeVisible();
  await expect(page.getByText("不会生成或保存 AI 候选。")).toBeVisible();

  await page.getByRole("button", { name: "显示示例学习版" }).click();
  await expect(page.getByRole("button", { name: "隐藏示例学习版" })).toBeVisible();
});

test("opens a grouped block menu without a persistent editor toolbar", async ({ page }) => {
  await page.goto("/preview/notebook");

  await page.getByRole("button", { name: "浏览内容块示例" }).click();

  await expect(page.getByRole("heading", { name: "内容块示例", exact: false })).toBeVisible();
  await expect(page.getByText("基础内容")).toBeVisible();
  await expect(page.getByText("学习闭环")).toBeVisible();
  // Block options render as a browsable list (the preview does not insert blocks).
  await expect(page.getByText("概念", { exact: true })).toBeVisible();
  await expect(page.getByText("可引用的术语定义")).toBeVisible();
});

test("keeps page identity and source-aware details behind a compact page menu", async ({ page }) => {
  await page.goto("/preview/notebook");

  await page.getByRole("button", { name: "更多页面操作" }).click();
  await page.getByRole("button", { name: "示例页面信息" }).click();

  await expect(page.getByText("以下属性均为示例")).toBeVisible();
  await expect(page.getByText("来源锚点 · 教材第 42 页")).toBeVisible();
});

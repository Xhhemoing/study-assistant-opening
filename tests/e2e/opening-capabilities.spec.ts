import { expect, test } from "./fixtures";
import { seedCapabilityAccount } from "./opening-capability-fixture";

test.describe("opening capabilities (U04)", () => {
  test("shows authorization failure rather than a working connector", async ({ page, request }) => {
    const f = await seedCapabilityAccount(request);
    try {
      await page.context().addCookies([f.cookie]);
      await page.goto("/opening/settings/connections");
      await expect(page.getByText("等待授权", { exact: true })).toBeVisible();
    } finally {
      await f.dispose();
    }
  });

  test("start offers the existing course and direct questions without fabricating mastery", async ({ page, request }) => {
    const f = await seedCapabilityAccount(request);
    try {
      await page.context().addCookies([f.cookie]);
      await page.goto("/opening/today");
      await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
      const start = page.getByRole("article", { name: "继续学习", exact: true }).getByRole("link", { name: "开始学习", exact: true });
      await expect(start).toBeVisible();
      await expect(start).toHaveAttribute("href", `/opening/courses/${f.courseId}/study`);
      await expect(page.getByRole("button", { name: "问 AI：概念、题目或资料里的任何一段", exact: true })).toBeEnabled();
      await expect(page.getByText(/掌握\s*%|掌握度|mastery/i)).toHaveCount(0);
    } finally {
      await f.dispose();
    }
  });

  test("course page leads with study and keeps knowledge chapters available without a mastery meter", async ({ page, request }) => {
    const f = await seedCapabilityAccount(request);
    try {
      await page.context().addCookies([f.cookie]);
      await page.goto(`/opening/courses/${f.courseId}`);
      await expect(page.getByRole("heading", { name: "本课内容", exact: true })).toBeVisible();
      const study = page.getByRole("navigation", { name: "课程学习方式", exact: true }).getByRole("link", { name: /^(打开学习|开始学习|继续学习|开始独立练习)$/ });
      await expect(study).toBeVisible();
      await expect(study).toHaveAttribute("href", `/opening/courses/${f.courseId}/study`);
      const units = page.getByRole("link", { name: "全部单元与学习目录", exact: true });
      await units.click();
      await expect(page.getByRole("navigation", { name: "课程分区", exact: true }).getByRole("link", { name: "学习", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "课程知识", exact: true })).toBeVisible();
      await expect(page.getByText(/掌握\s*%|掌握度/i)).toHaveCount(0);
    } finally {
      await f.dispose();
    }
  });
});

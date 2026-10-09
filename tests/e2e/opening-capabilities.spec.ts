import { expect, test } from "@playwright/test";
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

  test("today surfaces action digest without fabricating mastery", async ({ page, request }) => {
    const f = await seedCapabilityAccount(request);
    try {
      await page.context().addCookies([f.cookie]);
      await page.goto("/opening/today");
      await expect(page.getByRole("heading", { name: "今日学习工作台", exact: true })).toBeAttached();
      await expect(page.getByText(/掌握\s*%|掌握度|mastery/i)).toHaveCount(0);
    } finally {
      await f.dispose();
    }
  });

  test("course page leads with knowledge chapters not a mastery meter", async ({ page, request }) => {
    const f = await seedCapabilityAccount(request);
    try {
      await page.context().addCookies([f.cookie]);
      await page.goto(`/opening/courses/${f.courseId}`);
      await expect(page.getByRole("heading", { name: "课程知识", exact: true })).toBeVisible();
      await expect(page.getByText(/掌握\s*%|掌握度/i)).toHaveCount(0);
    } finally {
      await f.dispose();
    }
  });
});

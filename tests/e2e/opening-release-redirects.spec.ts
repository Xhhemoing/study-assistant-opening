import { expect, test } from "./fixtures";
import { isOpeningReleaseEnabled, loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

test.skip(!isOpeningReleaseEnabled(), "requires a web server started with OPENING_RELEASE=1");

test.describe("opening release redirects", () => {
  test.beforeAll(async () => {
    await seedOpeningOwner();
  });

  test("root redirects to opening today for the owner", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/");
      await expect(page).toHaveURL(/\/opening\/today$/);
    } finally {
      await context.close();
    }
  });

  test("legacy mock entries redirect so they cannot masquerade as official", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      const destinations = [
        ["/learn", "/opening/today"],
        ["/learn/review", "/opening/review?tab=cards"],
        ["/learn/practice/mock-item", "/opening/today"],
        ["/learn/goals", "/opening/today"],
        ["/learn/exams", "/opening/today"],
        ["/learn/marketplace", "/opening/today"],
        ["/explore", "/opening/today"],
        ["/preview/notebook", "/opening/today"],
      ] as const;
      for (const [path, target] of destinations) {
        await page.goto(path);
        await expect(page).toHaveURL(new URL(target, baseURL ?? "http://127.0.0.1:3000").toString());
        await expect(page.getByRole("navigation", { name: "学习工作台导航" })).toBeVisible();
        if (path === "/learn/review") {
          await expect(page.getByRole("navigation", { name: "复习分类" })
            .getByRole("link", { name: "记忆卡片", exact: true })).toHaveAttribute("aria-current", "page");
        }
      }
    } finally {
      await context.close();
    }
  });
});


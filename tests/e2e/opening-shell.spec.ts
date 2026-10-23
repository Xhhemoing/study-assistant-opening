import { expect, test } from "./fixtures";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

test.describe("opening shell", () => {
  test.beforeAll(async () => {
    await seedOpeningOwner();
  });

  test("shows the four responsive entry points", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto("/opening/today");
        const nav = page.getByRole("navigation", {
          name: viewport.width < 768 ? "学习工作台导航（移动端）" : "学习工作台导航",
          exact: true,
        });
        await expect(
          nav,
        ).toBeVisible();
        await expect(nav.getByRole("link", { name: "开始" })).toBeVisible();
        await expect(nav.getByRole("link", { name: "课程" })).toBeVisible();
        await expect(nav.getByRole("link", { name: "助理" })).toBeVisible();
        await expect(nav.getByRole("link", { name: "资料" })).toBeVisible();
        await expect(nav.getByRole("link", { name: "开始" })).toHaveAttribute(
          "aria-current",
          "page",
        );
        // Carried over from the retired workspace-navigation spec: the shell
        // must not introduce horizontal overflow at any viewport width.
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      }
    } finally {
      await context.close();
    }
  });

  test("start page offers direct questions and examples instead of fabricated resume data", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/opening/today");
      // A new owner can ask immediately; examples are not invented learning records.
      await expect(page.getByRole("heading", { name: "你好，今天想学什么？", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "消息输入", exact: true })).toBeEnabled();
      await expect(page.getByRole("list", { name: "可以这样问", exact: true }).getByRole("button")).toHaveCount(3);
      await expect(page.getByRole("button", { name: "拍题", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "上传", exact: true })).toBeVisible();
      await expect(page.getByText(/^上次学习：/)).toHaveCount(0);
      await expect(page.getByRole("article", { name: "继续学习", exact: true })).toHaveCount(0);
      const start = page.getByRole("navigation", { name: "学习工具", exact: true }).filter({ has: page.getByRole("link", { name: "新建课程", exact: true }) }).getByRole("link", { name: "新建课程", exact: true });
      await expect(start).toBeVisible();
      await expect(start).toHaveAttribute("href", "/opening/courses/new");
    } finally {
      await context.close();
    }
  });

  test("supports keyboard navigation into the entry points", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/opening/today");
      const nav = page.getByRole("navigation", { name: "学习工作台导航", exact: true });
      const today = nav.getByRole("link", { name: "开始" });
      await today.focus();
      await expect(today).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(nav.getByRole("link", { name: "课程" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/opening\/courses$/);
    } finally {
      await context.close();
    }
  });

  test("requires login for the opening shell", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await page.goto("/opening/today");
      await expect(page).toHaveURL(/\/login\?returnTo=%2Fopening%2Ftoday$/);
    } finally {
      await context.close();
    }
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`keeps the document during shell navigation at ${viewport.width}px`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport });
      try {
        await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        page.on("console", message => {
          if (message.type() === "error" && /Maximum update depth/.test(message.text())) pageErrors.push(message.text());
        });
        // This request comes from the mounted shell effect, so its response
        // proves hydration before we exercise an intercepted Next Link.
        const shellReady = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === "/api/opening/reviews" && url.searchParams.get("limit") === "1";
        });
        await page.goto("/opening/today");
        await shellReady;
        const nav = page.getByRole("navigation", {
          name: viewport.width < 768 ? "学习工作台导航（移动端）" : "学习工作台导航",
          exact: true,
        });
        await expect(nav.getByRole("link", { name: "开始", exact: true })).toBeVisible();
        const documentRequests: string[] = [];
        page.on("request", request => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests.push(request.url());
        });
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        await nav.getByRole("link", { name: "课程", exact: true }).click();
        await expect(page).toHaveURL(/\/opening\/courses$/);
        await expect(nav.getByRole("link", { name: "课程", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
        await nav.getByRole("link", { name: "资料", exact: true }).click();
        await expect(page).toHaveURL(/\/opening\/library$/);
        await expect(nav.getByRole("link", { name: "资料", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "资料", exact: true })).toBeVisible();
        await page.goBack();
        await expect(page).toHaveURL(/\/opening\/courses$/);
        await expect(nav.getByRole("link", { name: "课程", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
        await page.goForward();
        await expect(page).toHaveURL(/\/opening\/library$/);
        await expect(nav.getByRole("link", { name: "资料", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "资料", exact: true })).toBeVisible();
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
        expect(documentRequests).toEqual([]);
        expect(pageErrors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

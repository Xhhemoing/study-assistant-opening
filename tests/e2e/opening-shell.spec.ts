import { expect, test } from "./fixtures";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

test.describe("opening shell", () => {
  test.beforeAll(async () => {
    await seedOpeningOwner();
  });

  test("shows the three responsive entry points", async ({ browser, baseURL }) => {
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
        await expect(nav.getByRole("link", { name: "学习" })).toBeVisible();
        await expect(nav.getByRole("link", { name: /^复习/ })).toBeVisible();
        await expect(nav.getByRole("link")).toHaveCount(3);
        await expect(nav.getByRole("link", { name: "资料" })).toBeVisible();
        await expect(nav.getByRole("link", { name: "学习" })).toHaveAttribute(
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

  test("today offers first-course creation and an assistant entry instead of fabricated resume data", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/opening/today");
      await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "从第一门课程开始", exact: true })).toBeVisible();
      const firstCourse = page.getByRole("link", { name: "添加第一门课", exact: true });
      await expect(firstCourse).toBeVisible();
      await expect(firstCourse).toHaveAttribute("href", "/opening/courses/new");
      const question = page.getByRole("textbox", { name: "向 AI 提问", exact: true });
      await expect(question).toBeEnabled();
      const continueQuestion = page.getByRole("button", { name: "继续提问", exact: true });
      await expect(continueQuestion).toBeVisible();
      await expect(continueQuestion).toBeDisabled();
      await question.fill("如何开始学习？");
      await expect(continueQuestion).toBeEnabled();
      await expect(page.getByText(/^上次学习：/)).toHaveCount(0);
      await expect(page.getByRole("article", { name: "继续学习", exact: true })).toHaveCount(0);

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
      const today = nav.getByRole("link", { name: "学习" });
      await today.focus();
      await expect(today).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(nav.getByRole("link", { name: /^复习/ })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/opening\/review$/);
      await expect(nav.getByRole("link", { name: /^复习/ })).toHaveAttribute("aria-current", "page");
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
        await expect(nav.getByRole("link", { name: "学习", exact: true })).toBeVisible();
        const documentRequests: string[] = [];
        page.on("request", request => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests.push(request.url());
        });
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        await page.getByRole("link", { name: "全部课程", exact: true }).click();
        await expect(page).toHaveURL(/\/opening\/courses$/);
        await expect(nav.getByRole("link", { name: "学习", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "课程", exact: true })).toBeVisible();
        await nav.getByRole("link", { name: "资料", exact: true }).click();
        await expect(page).toHaveURL(/\/opening\/library$/);
        await expect(nav.getByRole("link", { name: "资料", exact: true })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: "资料", exact: true })).toBeVisible();
        await page.goBack();
        await expect(page).toHaveURL(/\/opening\/courses$/);
        await expect(nav.getByRole("link", { name: "学习", exact: true })).toHaveAttribute("aria-current", "page");
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

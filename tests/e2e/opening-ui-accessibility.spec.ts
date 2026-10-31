import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "./fixtures";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

// This is a browser CI definition, not a claim of local visual acceptance.
// It uses the guarded *_e2e database and real application routes/data APIs.
// No model, source parser, production account, or synthetic mastery is needed.
const courseTitle = "可访问性检查 · 线性代数";
const cardFront = "矩阵的第一列表示什么？";
let courseId: string;

test.beforeAll(async ({ request, baseURL }) => {
  await seedOpeningOwner();
  await loginOpeningOwner(request, baseURL!);
  const course = await request.post("/api/courses", {
    headers: { origin: baseURL! },
    data: { title: courseTitle, slug: `accessibility-${randomUUID()}`, description: "隔离测试课程；不包含掌握结论。" },
  });
  expect(course.status(), "the real course fixture must be created").toBe(201);
  courseId = (await course.json() as { course: { id: string } }).course.id;
  const card = await request.post("/api/cards", {
    headers: { origin: baseURL! },
    data: { front: cardFront, back: "第一列是第一个标准基向量变换后的向量。", reviewKind: "concept", courseId, skillLabel: "矩阵与基向量" },
  });
  expect(card.ok(), "the review must contain a real card, not only an empty shell").toBe(true);
});

test.beforeEach(async ({ context, baseURL }) => {
  await loginOpeningOwner(context.request, baseURL!);
  // Exercise the actual system-theme/motion preferences, including hydration.
  await context.addInitScript(() => {
    localStorage.setItem("aistudy.appearance.v1", JSON.stringify({ version: 1,
      preferences: { theme: "system", motion: "system", readingFont: "serif", diagnostics: false } }));
  });
});

type View = "today" | "courses" | "overview" | "units" | "progress" | "review" | "library" | "settings-appearance" | "settings-learning" | "settings-ai" | "lesson" | "assistant" | "agent";
const views: readonly View[] = ["today", "courses", "overview", "units", "progress", "review", "library", "settings-appearance", "settings-learning", "settings-ai", "lesson", "assistant", "agent"];
const conditions = [
  { name: "desktop light", viewport: { width: 1366, height: 900 }, colorScheme: "light", reducedMotion: "no-preference" },
  { name: "desktop dark", viewport: { width: 1366, height: 900 }, colorScheme: "dark", reducedMotion: "no-preference" },
  { name: "mobile 390px", viewport: { width: 390, height: 844 }, colorScheme: "light", reducedMotion: "no-preference" },
  { name: "reduced motion", viewport: { width: 1366, height: 900 }, colorScheme: "light", reducedMotion: "reduce" },
] as const;

/** Wait for visible business content, so an empty loading shell cannot pass. */
async function openView(page: Page, view: View) {
  const courseHref = `/opening/courses/${courseId}`;
  switch (view) {
    case "today":
      await page.goto("/opening/today");
      await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeAttached();
      // v4：已有课程时开始页直接给出唯一主动作，而不是「选择课程」空状态。
      await expect(page.locator('[data-today-primary-cta="true"]')).toBeVisible();
      break;
    case "courses":
      await page.goto("/opening/courses");
      await expect(page.getByRole("list", { name: "课程列表" }).getByRole("link", { name: new RegExp(courseTitle) })).toBeVisible();
      break;
    case "overview":
    case "units":
    case "progress": {
      await page.goto(`${courseHref}?tab=${view}`);
      await expect(page.getByRole("heading", { name: courseTitle, exact: true })).toBeVisible();
      const label = { overview: "学习", units: "学习", progress: "进展" }[view];
      await expect(page.getByRole("navigation", { name: "课程分区" }).getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
      if (view === "overview") await expect(page.getByRole("heading", { name: "本课内容", exact: true })).toBeVisible();
      if (view === "units") await expect(page.getByRole("heading", { name: "课程单元", exact: true })).toBeVisible();
      if (view === "progress") {
        await expect(page.getByRole("heading", { name: "学习进展与记录", exact: true })).toBeVisible();
        const progress = page.getByRole("region", { name: "学习进展", exact: true });
        await expect(progress).toHaveCount(1);
        await expect(progress.getByRole("link")).toHaveCount(0);
      }
      break;
    }
    case "review":
      await page.goto("/opening/review?tab=cards");
      await expect(page.getByRole("heading", { name: "复习", exact: true })).toBeVisible();
      await expect(page.getByText(cardFront, { exact: true })).toBeVisible();
      break;
    case "library":
      await page.goto("/opening/library");
      await expect(page.getByRole("tab", { name: "材料", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("heading", { name: "还没有材料", exact: true })).toBeVisible();
      break;
    case "settings-appearance":
      await page.goto("/opening/settings");
      await expect(page.getByRole("heading", { name: "外观与阅读", exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "设置分区" }).getByRole("link", { name: "外观", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("combobox", { name: "主题", exact: true })).toBeEnabled();
      await expect(page.getByRole("combobox", { name: "阅读字体", exact: true })).toBeEnabled();
      await expect(page.getByRole("combobox", { name: "动态效果", exact: true })).toBeEnabled();
      break;
    case "settings-learning":
      await page.goto("/opening/settings/learning");
      await expect(page.getByRole("navigation", { name: "设置分区" }).getByRole("link", { name: "学习", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("button", { name: "保存学习偏好", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "保存介入偏好", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "保存学期设置", exact: true })).toBeEnabled();
      break;
    case "settings-ai":
      await page.goto("/opening/settings/ai");
      await expect(page.getByRole("navigation", { name: "设置分区" }).getByRole("link", { name: "AI 与数据", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("region", { name: "当前模型与用量", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "重新读取模型设置", exact: true })).toBeEnabled();
      await expect(page.getByRole("region", { name: "AI 记忆设置", exact: true })).toBeVisible();
      break;
    case "lesson": {
      await page.goto(`${courseHref}/study/matrix`);
      const unitMenu = page.locator('summary[aria-label="选择学习单元"]');
      await expect(unitMenu).toBeVisible();
      await expect(unitMenu).toContainText("矩阵怎样变换平面向量");
      await unitMenu.click();
      const outline = page.getByRole("navigation", { name: "矩阵学习目录", exact: true });
      const questionUnit = outline.getByRole("button", { name: "3. 自己尝试", exact: true });
      await expect(questionUnit).toBeEnabled();
      await questionUnit.click();
      await expect(outline).not.toBeVisible();
      await expect(page.getByRole("heading", { name: "3. 自己尝试", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "我的原始思考", exact: true })).toBeEnabled();
      break;
    }
    case "agent": {
      await page.goto("/opening/agent");
      const input = page.getByRole("textbox", { name: "消息输入", exact: true });
      await expect(input).toBeVisible();
      // The initial conversation/source load disables the composer. Axe reads
      // text and computed colors in separate passes; starting while controls
      // unlock can pair enabled DOM with the previous disabled opacity.
      // Inspect the actual usable state, retaining every contrast assertion.
      await expect(input).toBeEnabled();
      await expect(page.getByRole("button", { name: "拍题", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "上传", exact: true })).toBeEnabled();
      break;
    }
    case "assistant": {
      await page.goto("/opening/assistant?context=none");
      const conversation = page.getByRole("region", { name: "学习对话", exact: true });
      await expect(conversation).toBeVisible();
      await expect(conversation.getByRole("heading", { name: "想弄懂什么？", exact: true })).toBeVisible();
      await expect(conversation.getByRole("textbox", { name: "消息输入", exact: true })).toBeVisible();
      break;
    }
  }
}

for (const condition of conditions) {
  test.describe(`UI accessibility · ${condition.name}`, () => {
    test.use({ viewport: condition.viewport, colorScheme: condition.colorScheme,
      contextOptions: { reducedMotion: condition.reducedMotion } });
    for (const view of views) {
      test(`${view} has no axe violations at any severity`, async ({ page }, testInfo) => {
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        let modelRequests = 0;
        await page.route("**/api/opening/turns", async route => {
          modelRequests += 1;
          await route.fulfill({ status: 503, json: { error: { code: "TEST_NO_MODEL", message: "This accessibility scenario must not request a model." } } });
        });
        await openView(page, view);
        await expect(page.locator("html")).toHaveAttribute("data-theme", condition.colorScheme);
        await expect(page.locator("html")).toHaveAttribute("data-motion", condition.reducedMotion === "reduce" ? "reduce" : "full");

        // All default axe violations block, including moderate/minor best practices.
        // Incomplete/manual-review findings stay in the attached full report.
        const result = await new AxeBuilder({ page }).analyze();
        await testInfo.attach("axe-results", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
        expect(result.violations.map(({ id, impact, help, nodes }) => ({ id, impact, help, targets: nodes.map(node => node.target) }))).toEqual([]);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(condition.viewport.width);
        if (view.startsWith("settings-")) {
          // Every settings section stays inside the shell; short pages need no
          // artificial scroll range merely to satisfy an old long-form scenario.
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(condition.viewport.height);
          const sections = page.getByRole("navigation", { name: "设置分区" }).getByRole("link");
          await sections.first().focus();
          for (let index = 1; index < await sections.count(); index += 1) await page.keyboard.press("Tab");
          await expect(sections.last()).toBeFocused();
          await expect(sections.last()).toBeInViewport({ ratio: 1 });
          expect(await page.evaluate(() => window.scrollY)).toBe(0);
        }
        if (view === "settings-appearance") {
          await page.getByRole("combobox", { name: "主题", exact: true }).focus();
          await page.keyboard.press("Tab");
          await expect(page.getByRole("combobox", { name: "阅读字体", exact: true })).toBeFocused();
          await page.keyboard.press("Tab");
          await expect(page.getByRole("combobox", { name: "动态效果", exact: true })).toBeFocused();
        }
        if (view === "settings-learning") {
          const main = page.locator("#main-content");
          const save = main.getByRole("button", { name: "保存介入偏好", exact: true });
          await expect(save).toBeEnabled();
          await save.scrollIntoViewIfNeeded();
          await expect(save).toBeInViewport();
          await save.focus();
          await page.keyboard.press("Tab");
          await expect(main.getByRole("button", { name: "重置为默认", exact: true })).toBeFocused();
          await page.keyboard.press("Shift+Tab");
          await expect(save).toBeFocused();
          // Semester settings remain a genuinely long form on the learning page.
          const semesterSave = main.getByRole("button", { name: "保存学期设置", exact: true });
          await semesterSave.scrollIntoViewIfNeeded();
          await expect(semesterSave).toBeInViewport();
          await semesterSave.focus();
          await expect(semesterSave).toBeFocused();
          expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
          expect(await page.evaluate(() => window.scrollY)).toBe(0);
          const bottomPath = testInfo.outputPath("settings-learning-bottom.png");
          await page.screenshot({ path: bottomPath });
          await testInfo.attach("settings-learning-bottom", { path: bottomPath, contentType: "image/png" });
          await main.evaluate(element => { element.focus({ preventScroll: true }); element.scrollTop = 0; });
        }
        if (condition.reducedMotion === "reduce") {
          const continuous = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity).map(animation => animation.id || animation.constructor.name));
          expect(continuous, "reduced motion must stop continuous animation").toEqual([]);
        }
        if (view === "review" && condition.name === "mobile 390px") {
          await page.setViewportSize({ width: 320, height: condition.viewport.height });
          const categories = page.getByRole("navigation", { name: "复习分类", exact: true }).getByRole("link");
          await categories.first().focus();
          for (let index = 1; index < await categories.count(); index += 1) await page.keyboard.press("Tab");
          await expect(categories.last()).toBeFocused();
          await expect(categories.last()).toBeInViewport({ ratio: 1 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
          const narrowPath = testInfo.outputPath("review-320-keyboard.png");
          await page.screenshot({ path: narrowPath });
          await testInfo.attach("review-320-keyboard", { path: narrowPath, contentType: "image/png" });
          await page.setViewportSize(condition.viewport);
        }
        expect(pageErrors).toEqual([]);
        expect(modelRequests).toBe(0);
        const screenshotPath = testInfo.outputPath("view.png");
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await testInfo.attach("view", { path: screenshotPath, contentType: "image/png" });
        if (view === "assistant") {
          // The assistant is a full-page conversation. Starting a fresh conversation
          // must release any modal/inert state just as closing the old drawer did.
          await page.getByRole("link", { name: "新对话", exact: true }).click();
          await expect(page).toHaveURL(/\/opening\/assistant\?context=none$/);
          const conversation = page.getByRole("region", { name: "学习对话", exact: true });
          await expect(conversation.getByRole("heading", { name: "想弄懂什么？", exact: true })).toBeVisible();
          await expect(page.getByRole("main")).toBeVisible();
          await expect.poll(() => page.locator("main").evaluate(main => {
            return Boolean(main.closest('[aria-hidden="true"],[inert],[hidden]'));
          })).toBe(false);
          await expect.poll(() => page.evaluate(() => {
            const focused = document.activeElement;
            return focused instanceof HTMLElement && Boolean(focused.closest('[inert],[hidden],[aria-hidden="true"]'));
          })).toBe(false);
          const composer = conversation.getByRole("textbox", { name: "消息输入", exact: true });
          await expect(composer).toBeEnabled();
          await composer.focus();
          await expect(composer).toBeFocused();
        }
      });
    }
  });
}

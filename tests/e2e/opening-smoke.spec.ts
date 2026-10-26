import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

// Deliberately avoid ./fixtures: this user-run suite must not reset a running environment's auth state.
async function capture(page: Page, info: TestInfo, name: string) {
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

async function hasVisibleText(body: Locator) {
  return body.evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      let visible = true;
      for (let element = node.parentElement; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (element.hidden || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) { visible = false; break; }
      }
      const range = document.createRange(); range.selectNodeContents(node);
      if (visible && [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) return true;
    }
    return false;
  });
}

test("new account completes the five-step Opening smoke journey", async ({ page }, info) => {
  const measurements: Record<string, unknown> = { candidate: process.env.AISTUDY_COMMIT, mode: "user-run full stack", completedSteps: [] };
  const completedSteps = measurements.completedSteps as string[];
  const pageErrors: string[] = [];
  let passed = false;
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    await test.step("register a fresh account and read the first lesson within 90 seconds", async () => {
      await page.goto("/register");
      await page.getByLabel("显示名称", { exact: true }).fill("Opening smoke");
      await page.getByLabel("邮箱", { exact: true }).fill(`opening-smoke-${randomUUID()}@example.com`);
      const password = `Smoke-${randomUUID()}!`;
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByLabel("确认密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "创建账户", exact: true }).click();
      await expect(page).toHaveURL(/\/onboarding(?:\?|$)/);
      await capture(page, info, "01-fresh-onboarding");
      const setup = page.getByRole("form", { name: "首次学习设置", exact: true });
      await setup.locator("#first-topic").fill("分数加法：1/2 + 1/3");
      await setup.locator("#first-goal").fill("理解为什么要通分，演示计算，并安排一道简单的分数加法数字题让我独立作答。");
      const started = performance.now();
      await setup.getByRole("button", { name: "保存目标并开始", exact: true }).click();
      await expect(page).toHaveURL(/\/opening\/courses\/[^/]+\/study\?/, { timeout: 90_000 });
      const lesson = page.locator('[data-teaching-workspace="true"] [data-study-unit-current="true"] [data-teaching-block]:is([data-catalog-id="text"], [data-catalog-id="math"], [data-catalog-id="step"], [data-catalog-id="example"])')
        .locator("[data-src-start]:not(h1):not(h2):not(h3):not(h4):not(h5):not(h6), p.whitespace-pre-wrap").filter({ hasText: /\S/ }).first();
      const remaining = Math.max(1, 90_000 - (performance.now() - started));
      await expect(lesson).toBeVisible({ timeout: remaining });
      await expect(lesson).toHaveText(/\S/, { timeout: Math.max(1, 90_000 - (performance.now() - started)) });
      measurements.lessonBodyMs = Math.round(performance.now() - started);
      expect(measurements.lessonBodyMs).toBeLessThanOrEqual(90_000);
      completedSteps.push("first_lesson");
      await capture(page, info, "02-first-lesson");
    });

    const workspace = page.locator('[data-teaching-workspace="true"]');
    let savedAnswer = "";
    await test.step("submit one real in-lesson answer and see grading", async () => {
      const practice = workspace.locator('[data-study-unit-current="true"] [data-inline-attempt]');
      while (!(await practice.isVisible())) {
        const current = workspace.locator('[data-study-unit-current="true"]');
        const previousUnit = await current.getAttribute("data-study-unit");
        await workspace.locator('[data-teaching-primary-advance="true"]').click();
        await expect(current).not.toHaveAttribute("data-study-unit", previousUnit!);
      }
      await expect(practice.getByRole("button", { name: "提交答案", exact: true })).toBeVisible();
      const choices = practice.getByRole("radio");
      if (await choices.count()) {
        await choices.first().check();
        savedAnswer = await choices.first().inputValue();
      } else {
        const numeric = practice.getByLabel(/^我的答案/);
        const answer = await numeric.count() ? numeric : practice.getByRole("textbox", { name: "我的想法", exact: true });
        savedAnswer = await numeric.count() ? "5/6" : "先把分母通分到 6，1/2=3/6，1/3=2/6，所以相加为 5/6。";
        await answer.fill(savedAnswer);
      }
      await practice.getByRole("button", { name: "提交答案", exact: true }).click();
      const grade = practice.getByRole("region", { name: "AI 批改结果", exact: true });
      await expect(grade).toBeVisible({ timeout: 120_000 });
      await expect(grade.getByRole("list", { name: "评分要点", exact: true })).toBeVisible();
      await expect(grade).not.toContainText("请核对题目与作答是否对应");
      await expect(grade.locator(":scope > p").first()).toHaveText(/^AI 批改 · (正确|需改进)$/);
      await expect(grade.locator(":scope > div").first()).toHaveText(/\S/);
      measurements.submittedAnswer = savedAnswer;
      completedSteps.push("graded_answer");
      await capture(page, info, "03-graded-answer");
    });

    await test.step("ask AI and record visible first text and completion times", async () => {
      await page.getByRole("button", { name: "问 AI", exact: true }).click();
      const log = page.getByRole("log", { name: "学习对话", exact: true });
      const replies = log.locator(":scope > ul > li").filter({ has: page.getByText("学习助理", { exact: true }) });
      const previousReplies = await replies.count();
      const announcement = page.locator('[data-reply-announcement="true"]');
      const previousAnnouncement = await announcement.innerText();
      await page.getByRole("textbox", { name: "消息输入", exact: true }).fill("为什么 1/2 + 1/3 不能直接把分子分母分别相加？请用一个简短例子解释。");
      const started = performance.now();
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const reply = replies.nth(previousReplies);
      const body = reply.locator('div[aria-busy] > div.text-text, :scope > p.whitespace-pre-wrap').first();
      await expect(body).toBeVisible({ timeout: 120_000 });
      await expect.poll(() => hasVisibleText(body), { timeout: 120_000, intervals: [100] }).toBe(true);
      measurements.firstVisibleTextMs = Math.round(performance.now() - started);
      const [, completedMs] = await Promise.all([
        capture(page, info, "04-ai-first-text"),
        (async () => {
          await expect(log).toHaveAttribute("aria-busy", "false", { timeout: 120_000 });
          await expect(announcement).not.toHaveText(previousAnnouncement, { timeout: 120_000 });
          await expect(announcement).toHaveText(/\S/);
          await expect(reply).not.toContainText(/这次没有得到回答|未能确认是否生成成功|已停止。/);
          return Math.round(performance.now() - started);
        })(),
      ]);
      measurements.answerCompleteMs = completedMs;
      measurements.timingMethod = "UI observation, 100ms text polling; not provider TTFT";
      expect(measurements.answerCompleteMs).toBeGreaterThanOrEqual(measurements.firstVisibleTextMs as number);
      completedSteps.push("ai_reply");
      await capture(page, info, "05-ai-complete");
    });

    await test.step("refresh and restore the same activity, unit, answer and grading", async () => {
      const url = page.url();
      const version = await workspace.getAttribute("data-content-version");
      const block = await workspace.locator("[data-current-block-id]").getAttribute("data-current-block-id");
      const unit = await workspace.locator('[data-study-unit-current="true"]').getAttribute("data-study-unit");
      await page.reload();
      await expect(page).toHaveURL(url);
      await expect(workspace).toHaveAttribute("data-content-version", version!);
      // Opening the content tab changes presentation only; it must not move the saved checkpoint.
      const closeTools = page.getByRole("button", { name: "关闭学习工具", exact: true });
      if (await closeTools.isVisible()) await closeTools.click();
      await expect(workspace.locator("[data-current-block-id]")).toHaveAttribute("data-current-block-id", block!);
      await expect(workspace.locator('[data-study-unit-current="true"]')).toHaveAttribute("data-study-unit", unit!);
      const practice = workspace.locator('[data-study-unit-current="true"] [data-inline-attempt]');
      await expect(practice).toContainText(savedAnswer);
      await expect(practice.getByRole("region", { name: "AI 批改结果", exact: true })).toBeVisible();
      completedSteps.push("restored_position");
      await capture(page, info, "06-restored-position");
    });

    await test.step("verify the account version against the intended merged commit", async () => {
      const expected = process.env.AISTUDY_COMMIT!;
      const response = await page.request.get("/api/opening/health");
      expect(response.status()).toBe(200);
      const health = await response.json() as { commit?: string; builtAt?: string };
      const publicCommit = expected.slice(0, 8).toLowerCase();
      expect(health.commit?.toLowerCase()).toBe(publicCommit);
      measurements.observedCommit = health.commit;
      expect(Number.isFinite(Date.parse(health.builtAt ?? ""))).toBe(true);
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "学习工具与账户", exact: true })).toContainText(new RegExp(`版本 ${publicCommit}`, "i"));
      completedSteps.push("release_version");
      await capture(page, info, "07-release-version");
    });
    expect(pageErrors).toEqual([]);
    passed = true;
  } finally {
    measurements.pageErrors = pageErrors;
    measurements.status = passed ? "passed" : "incomplete_or_failed";
    await info.attach("opening-smoke-measurements", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  }
});

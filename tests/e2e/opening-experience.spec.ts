import { expect, test } from "./fixtures";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

test.beforeAll(async () => {
  await seedOpeningOwner();
});
test.beforeEach(async ({ context, baseURL }) => { await loginOpeningOwner(context.request, baseURL!); });

test("compact mobile navigation and settings retain every destination and predictable Escape behavior", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/opening/today");
  const navigation = page.getByRole("navigation", { name: "学习工作台导航（移动端）", exact: true });
  await expect(navigation.getByRole("link")).toHaveCount(3);
  for (const [label, href] of [["学习", "/opening/today"], ["复习", "/opening/review"], ["资料", "/opening/library"]] as const) {
    await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const account = page.getByRole("button", { name: "更多", exact: true });
  await account.click();
  const more = page.getByRole("dialog").filter({ has: page.getByRole("navigation", { name: "学习工具与账户", exact: true }) });
  await expect(more).toBeVisible();
  for (const [label, href] of [[/^学习安排/, "/opening/settings/planning"], [/^设置$/, "/opening/settings"], [/^导出$/, "/opening/settings/export"], [/^全部对话$/, "/opening/assistant"]] as const) {
    await expect(more.getByRole("link", { name: label })).toHaveAttribute("href", href);
  }
  await expect(more.getByRole("link", { name: "连接", exact: true })).toHaveCount(0);
  await expect(more.getByRole("link", { name: "冲刺", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(more).not.toBeVisible();
  await expect(account).toBeFocused();
  await account.click();
  await more.getByRole("button", { name: "进入专注模式", exact: true }).click();
  await expect(navigation).not.toBeVisible();
  await account.click();
  const timer = more.getByRole("button", { name: "25:00", exact: true });
  await timer.click();
  await expect(more.getByRole("combobox", { name: "专注时长" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).not.toBeVisible();
  await expect(account).toBeFocused();
  await expect(navigation).not.toBeVisible();
  await expect(page.locator("[data-app-shell]")).toHaveAttribute("data-focus", "true");
  await page.keyboard.press("Escape");
  await expect(navigation).toBeVisible();
  await account.click();
  await more.getByRole("link", { name: "设置", exact: true }).click();
  await expect(page).toHaveURL(/\/opening\/settings$/);
  await expect(page.getByRole("link", { name: /高级设置/ }).first()).toHaveAttribute("href", "/opening/settings/advanced");
  await expect(navigation).toBeVisible();
});

test("a real note can be saved once with Ctrl S, restored, and found after clearing a failed search", async ({ page }) => {
  await page.goto("/opening/library/new");
  const title = page.getByRole("textbox", { name: "笔记标题" });
  await expect(title).toBeVisible({ timeout: 45_000 });
  const editorUrl = page.url();
  const id = editorUrl.split("/").at(-1)!;
  let saves = 0;
  page.on("request", request => { if (request.method() === "PATCH" && new URL(request.url()).pathname === `/api/documents/${id}`) saves += 1; });
  await title.fill("体验回归：我的学习笔记");
  const saved = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/documents/${id}` && response.ok());
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+s");
  await saved;
  await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
  expect(saves).toBe(1);
  await page.reload();
  await expect(title).toHaveValue("体验回归：我的学习笔记");
  await page.getByRole("link", { name: "返回知识库" }).click();
  await expect(page.getByRole("tab", { name: "材料", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "笔记", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索笔记标题" }).fill("不存在的匹配词");
  await expect(page.getByRole("heading", { name: "没有找到匹配的笔记" })).toBeVisible();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page.getByRole("link").filter({ hasText: "体验回归：我的学习笔记" })).toBeVisible();
});

test("course drafts survive navigation and server errors, and successful creation clears the draft", async ({ page }) => {
  await page.goto("/opening/courses/new");
  await page.getByLabel("课程名称", { exact: true }).fill("体验回归课程");
  await page.getByLabel("描述", { exact: true }).fill("从真实问题开始的一门课程");
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("aistudy.course-draft.")).length)).toBe(1);
  await page.getByRole("link", { name: "全部课程", exact: true }).click();
  await page.getByRole("link", { name: "新建课程", exact: true }).click();
  await expect(page.getByLabel("课程名称", { exact: true })).toHaveValue("体验回归课程");
  await expect(page.getByLabel("Slug", { exact: true })).toHaveCount(0);
  await page.route("**/api/courses", route => route.request().method() === "POST" ? route.fulfill({ status: 409, json: { error: { code: "CONFLICT", message: "slug conflict" } } }) : route.continue());
  await page.getByRole("button", { name: "创建课程", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "课程可能已创建" })).toBeVisible();
  await expect(page.getByLabel("课程名称", { exact: true })).toHaveValue("体验回归课程");
  await page.unroute("**/api/courses");
  await page.getByRole("button", { name: "另建一门课程", exact: true }).click();
  await page.getByRole("button", { name: "创建课程", exact: true }).click();
  await expect(page).toHaveURL(/\/opening\/courses\/[0-9a-f-]{36}$/);
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("aistudy.course-draft.")).length)).toBe(0);
});

test("Chinese input composition sends only a committed content search", async ({ page }) => {
  await page.goto("/opening/library");
  await page.clock.install();
  const searches: string[] = [];
  await page.route("**/api/search?*", async route => { searches.push(new URL(route.request().url()).searchParams.get("q") ?? ""); await route.fulfill({ json: { hits: [] } }); });
  await page.getByRole("button", { name: "打开全局搜索", exact: true }).click();
  const input = page.getByRole("combobox", { name: "搜索页面、笔记和课程" });
  await input.dispatchEvent("compositionstart");
  await input.fill("导数");
  await page.clock.runFor(500);
  expect(searches).toEqual([]);
  await input.dispatchEvent("compositionend", { data: "导数" });
  await page.clock.runFor(500);
  await expect.poll(() => searches).toEqual(["导数"]);
});

test("an uncertain note creation offers a safe return instead of creating the note again", async ({ page }) => {
  let creates = 0;
  await page.route("**/api/documents", async route => {
    if (route.request().method() !== "POST") return route.continue();
    creates += 1;
    await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "not confirmed" } } });
  });
  await page.goto("/opening/library/new");
  await expect(page.getByRole("alert").filter({ hasText: "创建结果尚未确认" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "检查知识库", exact: true }).click();
  await expect(page).toHaveURL(/\/opening\/library$/);
  expect(creates).toBe(1);
});

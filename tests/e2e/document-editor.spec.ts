import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("opens the local note editor from Library", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
      data: userInput("editor-entry"),
    });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/library");
    await page.getByRole("link", { name: "新建笔记" }).click();
    await expect(page).toHaveURL(/\/library\/new$/);
    await expect(page.getByRole("heading", { name: "新建笔记" })).toBeVisible();
    await expect(page.locator(".bn-editor")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("edits, saves, undoes, and restores a local note draft", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
      data: userInput("editor-interactions"),
    });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto("/library/new");
    await expect(page.locator(".editor-save-status")).toContainText("有未保存修改");
    const title = page.getByRole("textbox", { name: "笔记标题" });
    await title.fill("终身学习笔记");

    const editor = page.locator(".bn-editor");
    await editor.click();
    await page.keyboard.type("第一段：把想法写下来。");
    await page.keyboard.press("Enter");
    await page.keyboard.type("第二段：保留稳定的块结构。");
    await expect(editor).toContainText("第一段：把想法写下来。");
    await expect(editor).toContainText("第二段：保留稳定的块结构。");

    await page.getByRole("button", { name: "撤销" }).click();
    await expect(editor).not.toContainText("第二段：保留稳定的块结构。");
    await page.getByRole("button", { name: "重做" }).click();
    await expect(editor).toContainText("第二段：保留稳定的块结构。");

    await page.getByRole("button", { name: "保存草稿" }).click();
    await expect(page.getByRole("status")).toContainText("已保存到本机");

    await page.reload();
    await expect(title).toHaveValue("终身学习笔记");
    await expect(page.locator(".bn-editor")).toContainText("第一段：把想法写下来。");
    await expect(page.locator(".bn-editor")).toContainText("第二段：保留稳定的块结构。");
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("keeps the editor inside the viewport at mobile and desktop sizes", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
      data: userInput("editor-responsive"),
    });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    for (const viewport of [
      { width: 320, height: 800 },
      { width: 768, height: 900 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/library/new");
      await expect(page.getByRole("heading", { name: "新建笔记" })).toBeVisible();
      await expect(page.locator(".bn-editor")).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    }
  } finally {
    await context.close();
  }
});

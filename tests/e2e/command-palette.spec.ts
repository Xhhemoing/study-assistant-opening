import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("finds a note through the global command palette and navigates to it", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { data: userInput("command-palette") });
    expect(registered.status()).toBe(201);

    const created = await context.request.post("/api/documents", {
      data: {
        title: "检索目标笔记",
        blocks: [
          {
            id: crypto.randomUUID(),
            type: "paragraph",
            content: { text: "包含独特关键词的行列式展开公式" },
          },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const documentId = (await created.json()).document.id as string;

    const page = await context.newPage();
    await page.goto("/library");
    await page.keyboard.press("Control+K");

    const input = page.getByRole("combobox", { name: "搜索笔记和操作" });
    await expect(input).toBeVisible();
    const searching = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/search" && response.ok(),
    );
    await input.fill("行列式展开");
    await searching;

    await expect(page.getByRole("option", { name: /检索目标笔记/ })).toBeVisible();
    await page.getByRole("option", { name: /检索目标笔记/ }).click();

    await expect(page).toHaveURL(new RegExp(`/library/${documentId}`));
  } finally {
    await context.close();
  }
});

test("shows the no-match state for an unknown query", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { data: userInput("palette-empty") });
    expect(registered.status()).toBe(201);

    const page = await context.newPage();
    await page.goto("/library");
    await page.keyboard.press("Control+K");

    const input = page.getByRole("combobox", { name: "搜索笔记和操作" });
    await input.fill("绝不存在的关键词xyz");
    await expect(page.getByText("没有匹配内容")).toBeVisible();
  } finally {
    await context.close();
  }
});

import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return { email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`, password: "password123", displayName: label };
}

test("persists a goal-free exploration, blocks, branch, and close/resume state", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: userInput("exploration-owner") });
    expect(registered.status()).toBe(201);
    const page = await context.newPage();
    await page.goto("/explore");
    await page.getByLabel("探索主题").fill("Understand persistence");
    await page.getByRole("button", { name: "开始探索" }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]+$/);
    await page.getByLabel("内容类型").selectOption("hypothesis");
    await page.getByLabel("探索内容").fill("The root branch is durable");
    await page.getByRole("button", { name: "添加内容" }).click();
    await page.getByLabel("内容类型").selectOption("open_question");
    await page.getByLabel("探索内容").fill("What should branch next?");
    await page.getByRole("button", { name: "添加内容" }).click();
    await page.getByLabel("分支标题").fill("Alternative path");
    await page.getByRole("button", { name: "创建分支" }).click();
    await page.getByRole("button", { name: "关闭探索" }).click();
    await expect(page.getByText("已关闭")).toBeVisible();
    await page.getByRole("button", { name: "恢复探索" }).click();
    await expect(page.getByText("进行中")).toBeVisible();
    await page.reload();
    await expect(page.getByText("The root branch is durable")).toBeVisible();
    await expect(page.getByText("What should branch next?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Alternative path" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("does not expose another user's exploration", async ({ browser, baseURL }) => {
  const ownerContext = await browser.newContext({ baseURL });
  const otherContext = await browser.newContext({ baseURL });
  try {
    const owner = await ownerContext.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: userInput("exploration-owner") });
    const other = await otherContext.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: userInput("exploration-other") });
    expect(owner.status()).toBe(201);
    expect(other.status()).toBe(201);
    const created = await ownerContext.request.post("/api/explorations", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: { title: "Private exploration" } });
    const id = (await created.json()).exploration.id as string;
    const denied = await otherContext.request.get(`/api/explorations/${id}`);
    expect(denied.status()).toBe(403);
  } finally {
    await ownerContext.close();
    await otherContext.close();
  }
});

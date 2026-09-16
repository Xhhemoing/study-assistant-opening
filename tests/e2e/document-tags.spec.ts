import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("persists normalized document tags and clears them", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: userInput("document-tags") });
    expect(registered.status()).toBe(201);
    const created = await context.request.post("/api/documents", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
      data: {
        title: "Tagged note",
        blocks: [{ id: crypto.randomUUID(), type: "paragraph", content: { text: "body" } }],
      },
    });
    expect(created.status()).toBe(201);
    const documentId = (await created.json()).document.id as string;

    const page = await context.newPage();
    await page.goto(`/library/${encodeURIComponent(documentId)}`);
    const input = page.getByRole("textbox", { name: "新增标签" });
    await input.fill("  \uFF34\uFF2F\uFF30\uFF29\uFF23  ");
    await page.getByRole("button", { name: "添加标签" }).click();
    await expect(page.getByText("TOPIC", { exact: true })).toBeVisible();

    await input.fill("topic");
    await page.getByRole("button", { name: "添加标签" }).click();
    await expect(page.getByText("TOPIC", { exact: true })).toHaveCount(1);

    await page.reload();
    await expect(page.getByText("TOPIC", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "移除标签 TOPIC" }).click();
    await expect(page.getByText("还没有标签")).toBeVisible();

    await page.reload();
    await expect(page.getByText("还没有标签")).toBeVisible();
  } finally {
    await context.close();
  }
});

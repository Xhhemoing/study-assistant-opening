import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("creates, retypes, and deletes an outgoing relation across reloads", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { data: userInput("document-relations") });
    expect(registered.status()).toBe(201);
    const create = async (title: string) => {
      const response = await context.request.post("/api/documents", {
        data: {
          title,
          blocks: [{ id: crypto.randomUUID(), type: "paragraph", content: { text: "body" } }],
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).document as { id: string };
    };
    const source = await create("Relation source");
    const target = await create("Relation target");
    const page = await context.newPage();

    await page.goto(`/library/${encodeURIComponent(source.id)}`);
    await expect(page.getByRole("heading", { name: "关联笔记" })).toBeVisible();
    await page.getByRole("textbox", { name: "关联目标 ID" }).fill(target.id);
    const createRequest = page.waitForResponse((response) =>
      response.url().endsWith(`/api/documents/${encodeURIComponent(source.id)}/relations`) &&
      response.request().method() === "POST" && response.status() === 201,
    );
    await page.getByRole("button", { name: "创建关联" }).click();
    await createRequest;
    await expect(page.getByRole("link", { name: "Relation target" })).toBeVisible();

    const typeSelect = page.getByRole("combobox", { name: "已有关联类型" });
    const updateRequest = page.waitForResponse((response) =>
      response.url().includes(`/api/documents/${encodeURIComponent(source.id)}/relations/`) &&
      response.request().method() === "PATCH" && response.ok(),
    );
    await typeSelect.selectOption("supports");
    await updateRequest;
    await page.reload();
    await expect(page.getByRole("combobox", { name: "已有关联类型" })).toHaveValue("supports");

    await page.goto(`/library/${encodeURIComponent(target.id)}`);
    await expect(page.getByRole("link", { name: "Relation source" })).toBeVisible();
    await page.goto(`/library/${encodeURIComponent(source.id)}`);
    const deleteRequest = page.waitForResponse((response) =>
      response.url().includes(`/api/documents/${encodeURIComponent(source.id)}/relations/`) &&
      response.request().method() === "DELETE" && response.status() === 204,
    );
    await page.getByRole("button", { name: "删除关联 Relation target" }).click();
    await deleteRequest;
    await expect(page.getByText("还没有从这篇笔记发出的关联")).toBeVisible();
    await page.reload();
    await expect(page.getByText("还没有从这篇笔记发出的关联")).toBeVisible();
  } finally {
    await context.close();
  }
});

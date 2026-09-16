import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test("persists a wiki link and shows the backlink on the target note", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" }, data: userInput("knowledge-links") });
    expect(registered.status()).toBe(201);

    const create = async (title: string) => {
      const response = await context.request.post("/api/documents", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
        data: {
          title,
          blocks: [{ id: crypto.randomUUID(), type: "paragraph", content: { text: "" } }],
        },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).document as { id: string };
    };

    const target = await create("Knowledge link target");
    const source = await create("Knowledge link source");

    const page = await context.newPage();
    await page.goto(`/library/${encodeURIComponent(source.id)}`);
    await expect(page.locator(".bn-editor")).toBeVisible();
    await page.locator(".bn-editor").click();
    await page.keyboard.type("[[Knowledge link target]]");
    const indexing = page.waitForResponse((response) =>
      response.url().endsWith(`/api/documents/${encodeURIComponent(source.id)}/links`) &&
      response.request().method() === "POST" && response.ok(),
    );
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("status")).toContainText("已保存");
    await indexing;

    await page.goto(`/library/${encodeURIComponent(target.id)}`);
    await expect(page.getByRole("heading", { name: "反向链接" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Knowledge link source" })).toHaveAttribute(
      "href",
      `/library/${encodeURIComponent(source.id)}`,
    );
  } finally {
    await context.close();
  }
});

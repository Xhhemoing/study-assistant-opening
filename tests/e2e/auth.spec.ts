import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return {
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    password: "password123",
    displayName: label,
  };
}

test.describe("authentication through the live web server", () => {
  test("registers in the browser and enters onboarding", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("显示名称").fill("Browser User");
    await page.getByLabel("邮箱").fill(userInput("browser-user").email);
    await page.getByLabel("密码", { exact: true }).fill("password123");
    await page.getByLabel("确认密码").fill("password123");
    await page.getByRole("button", { name: "创建账户" }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "你想从哪里开始？" })).toBeVisible();
  });

  test("blocks cross-user document access through live HTTP", async ({ browser, baseURL }) => {
    const contextA = await browser.newContext({ baseURL });
    const contextB = await browser.newContext({ baseURL });
    try {
      const registeredA = await contextA.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
        data: userInput("browser-a"),
      });
      const registeredB = await contextB.request.post("/api/auth/register", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
        data: userInput("browser-b"),
      });
      expect(registeredA.status()).toBe(201);
      expect(registeredB.status()).toBe(201);

      const created = await contextB.request.post("/api/documents", { headers: { origin: baseURL ?? "http://127.0.0.1:3000" },
        data: {
          title: "Browser B private note",
          blocks: [
            {
              id: randomUUID(),
              type: "paragraph",
              content: { text: "private" },
            },
          ],
        },
      });
      expect(created.status()).toBe(201);
      const body = (await created.json()) as { document: { id: string } };

      const denied = await contextA.request.get(`/api/documents/${body.document.id}`);
      expect(denied.status()).toBe(403);
      const deniedBody = (await denied.json()) as { error: { code: string } };
      expect(deniedBody.error.code).toBe("WORKSPACE_FORBIDDEN");
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

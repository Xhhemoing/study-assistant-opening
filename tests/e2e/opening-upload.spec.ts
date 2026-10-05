import { expect, test } from "@playwright/test";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

/**
 * Real opening upload loop. Requires the Playwright web server plus MinIO.
 * Do not stub /api/opening/sources with page.route.
 */
test.describe("opening upload", () => {
  test.beforeAll(async () => {
    await seedOpeningOwner();
  });

  test("uploads a pdf and can open the stored original after a failed parse label", async ({
    browser,
    baseURL,
  }) => {
    // The failed-parse label alone may take up to 120s on CI; keep the test budget above it.
    test.setTimeout(180_000);
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/opening/assistant");
      const original = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
      await page.getByLabel("选择文件或拍照").setInputFiles({
        name: "notes.pdf",
        mimeType: "application/pdf",
        buffer: original,
      });
      await expect(page.getByText(/已上传 \d+%/)).toBeVisible();
      const sourceRow = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "notes.pdf", exact: true }) });
      await expect(sourceRow).toBeVisible();
      await expect(sourceRow.getByText("原件已保存，解析失败", { exact: true })).toBeVisible({ timeout: 120_000 });
      await sourceRow.getByRole("button", { name: "查看原件", exact: true }).click();
      const originalLink = page.getByRole("link", { name: "打开原件 v0", exact: true });
      await expect(originalLink).toBeVisible();
      const download = await context.request.get((await originalLink.getAttribute("href"))!);
      expect(download.status()).toBe(200);
      expect(await download.body()).toEqual(original);
      await page.reload();
      await expect(sourceRow.getByText("原件已保存，解析失败", { exact: true })).toBeVisible();
      await sourceRow.getByRole("button", { name: "查看原件", exact: true }).click();
      await expect(originalLink).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

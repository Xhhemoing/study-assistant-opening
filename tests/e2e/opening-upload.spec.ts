import { expect, test } from "@playwright/test";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

/**
 * Real opening upload loop. Requires the Playwright web server plus MinIO.
 * Do not stub /api/opening/sources with page.route.
 *
 * Since a8d7c8d the source list, "查看原件" and the original viewer live in the
 * material library (/opening/library?tab=materials); the assistant page only
 * keeps a compact upload strip. The Playwright web server starts no worker, so
 * the parse outcome is not asserted here (the isolated OPENING_E2E workflow
 * spec covers the real parser); this spec proves the stored original is
 * reachable while parsing is still pending, before and after a reload.
 */
test.describe("opening upload", () => {
  test.beforeAll(async () => {
    await seedOpeningOwner();
  });

  test("uploads a pdf in the material library and opens the stored original", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/opening/library?tab=materials");
      const name = `notes-${Date.now()}.pdf`;
      const original = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
      await page.locator('#upload input[type="file"]').setInputFiles({
        name,
        mimeType: "application/pdf",
        buffer: original,
      }, { timeout: 30_000 });
      await expect(page.getByRole("list", { name: "上传队列" }).getByText("已保存，正在解析")).toBeVisible({ timeout: 30_000 });
      const sourceRow = page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
      await expect(sourceRow).toBeVisible();
      await expect(sourceRow.getByText(/^原件已保存，/)).toBeVisible();
      await sourceRow.getByRole("button", { name: "查看原件", exact: true }).click({ timeout: 15_000 });
      const originalLink = page.getByRole("link", { name: "打开原件 v0", exact: true });
      await expect(originalLink).toBeVisible();
      const download = await context.request.get((await originalLink.getAttribute("href"))!);
      expect(download.status()).toBe(200);
      expect(await download.body()).toEqual(original);
      await page.reload();
      await expect(sourceRow.getByText(/^原件已保存，/)).toBeVisible();
      await sourceRow.getByRole("button", { name: "查看原件", exact: true }).click({ timeout: 15_000 });
      await expect(originalLink).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

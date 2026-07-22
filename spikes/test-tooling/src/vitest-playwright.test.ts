import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

describe("Vitest + Playwright tooling", () => {
  it("launches Chromium and reads page content", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent("<main><h1>AIstudy spike</h1></main>");
      const text = await page.locator("h1").textContent();
      expect(text).toBe("AIstudy spike");
    } finally {
      await browser.close();
    }
  });
});

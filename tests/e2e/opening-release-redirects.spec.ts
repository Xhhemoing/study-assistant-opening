import { expect, test } from "@playwright/test";
import { isOpeningReleaseEnabled, loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

test.skip(!isOpeningReleaseEnabled(), "requires a web server started with OPENING_RELEASE=1");

test.describe("opening release redirects", () => {
  test.beforeAll(async () => {
    await seedOpeningOwner();
  });

  test("root redirects to opening today for the owner", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/");
      await expect(page).toHaveURL(/\/opening\/today$/);
    } finally {
      await context.close();
    }
  });

  test("legacy mock entries redirect so they cannot masquerade as official", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      for (const path of ["/learn", "/explore", "/preview/notebook"]) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/opening\/today$/);
      }
    } finally {
      await context.close();
    }
  });
});

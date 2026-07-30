import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { chromium, type Browser } from "playwright";

const databaseUrl = process.env.DATABASE_URL;
const baseURL = process.env.E2E_BASE_URL;

describe("workspace navigation", () => {
  const sql = databaseUrl ? createSqlClient(databaseUrl) : undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    if (!baseURL) return;
    if (!sql) {
      throw new Error("DATABASE_URL is required when E2E_BASE_URL is set");
    }

    await applyMigrations(sql);
    await sql`TRUNCATE
      course_asset_memberships,
      courses,
      library_properties,
      library_relations,
      library_revisions,
      library_blocks,
      library_documents,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;

    if (baseURL) {
      browser = await chromium.launch({ headless: true });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await sql?.end({ timeout: 5 });
  });

  it("keeps Learn, Explore, and Library equally available across viewport sizes", async () => {
    if (!baseURL) {
      const { renderWorkspaceNavigation } = await import(
        "../../apps/web/src/features/workspace/navigation"
      );
      const html = renderWorkspaceNavigation("learn");

      expect(html).toContain("Learn");
      expect(html).toContain("Explore");
      expect(html).toContain("Library");
      return;
    }

    const context = await browser!.newContext({ baseURL });
    const email = `navigation-${randomUUID()}@example.com`;
    const registered = await context.request.post("/api/auth/register", {
      data: { email, password: "password123", displayName: "Navigation User" },
    });
    expect(registered.ok()).toBe(true);

    const page = await context.newPage();
    for (const viewport of [
      { width: 320, height: 800 },
      { width: 768, height: 900 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/learn");
      await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Learn" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Explore" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Library" })).toBeVisible();
    }

    await page.getByRole("link", { name: "Explore" }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await page.reload();
    await expect(page).toHaveURL(/\/explore$/);
    await context.close();
  });
});

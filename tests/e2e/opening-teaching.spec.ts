/**
 * V2-16 — Teaching loop e2e skeleton.
 * Full visual / live-model script remains pending_user until Paula runs it.
 * Requires both OPENING_TEACHING_LOOP and OPENING_TEACHING_WORKSPACE for UI trial.
 * real_model = not_run (never claim green from fixture-only path).
 */
import { expect, test } from "./fixtures";
import { loginOpeningOwner, seedOpeningOwner } from "./opening-auth";

const dualFlagsOn =
  process.env.OPENING_TEACHING_LOOP === "1" ||
  process.env.OPENING_TEACHING_LOOP === "true" ||
  process.env.OPENING_TEACHING_LOOP === "yes";

const workspaceOn =
  process.env.OPENING_TEACHING_WORKSPACE === "1" ||
  process.env.OPENING_TEACHING_WORKSPACE === "true" ||
  process.env.OPENING_TEACHING_WORKSPACE === "yes";

test.describe("opening teaching loop (V2-16 skeleton)", () => {
  test.skip(
    process.env.OPENING_E2E !== "1",
    "requires isolated Opening e2e env (OPENING_E2E=1); visual accept pending_user",
  );

  test.beforeAll(async () => {
    await seedOpeningOwner();
  });

  test("smoke: today shell reachable when release/e2e env is up", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginOpeningOwner(context.request, baseURL ?? "http://127.0.0.1:3000");
      const page = await context.newPage();
      await page.goto("/opening/today");
      await expect(
        page.getByRole("navigation", { name: "学习工作台导航" }),
      ).toBeVisible();
      // Dual-flag note: full TeachingWorkspace chrome only when both loop+workspace on.
      // Do not assert live model / compiled blocks here — real_model=not_run.
      if (dualFlagsOn && workspaceOn) {
        // Soft presence check only — may show empty/honest CTA without ready activity.
        await expect(page.getByRole("heading", { name: /今日/ })).toBeAttached();
      }
    } finally {
      await context.close();
    }
  });

  test("documented pending_user: enter→teach→ask→attempt→pause→resume visual script", async () => {
    // Intentionally empty until user-browser script runs under dual flags + real materials/model.
    // learning_effect remains unknown; UX checklist recorded separately in Implement evidence.
    test.info().annotations.push({
      type: "pending_user",
      description:
        "Paula/user visual: enter teaching → AI teach blocks → local ask → attempt → pause → resume; flags both on; real_model separate",
    });
    expect(true).toBe(true);
  });
});
